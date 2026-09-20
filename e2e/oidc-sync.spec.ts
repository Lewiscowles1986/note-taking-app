import { test, expect, step, seedNotes, type NoteSeed, APP_PATH } from './fixtures';

/**
 * OIDC + never-delete end-to-end against the REAL reference server
 * (server/index.mjs on :8080) and the built app (vite preview on :4173).
 *
 * Run (both processes must be up):
 *   E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/oidc-sync.spec.ts
 *
 * Skips itself when the server is not reachable, so `npm run test:e2e` stays
 * green without the reference server running.
 *
 * Covers, end to end:
 *  - full OIDC redirect flow (server-rendered login page, PKCE exchange,
 *    callback validation, session stored, signed-in identity in Settings)
 *  - sync pushes local notes to the server and pulls them into a SECOND,
 *    independent browser context (fresh client = same user, no exceptions)
 *  - server-side deletion → client 1 queues a keep-or-delete notification and
 *    the local note is NOT removed
 *  - Keep → permanent exception in localStorage; re-sync does not re-prompt
 *  - the same flow on client 2 choosing Delete → note removed locally there
 */

function makeNote(overrides: Partial<NoteSeed> = {}): NoteSeed {
  const now = new Date();
  return {
    title: 'Untitled',
    content: '',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: now,
    updatedAt: now,
    editDates: [now.toISOString().slice(0, 10)],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

const SERVER = 'http://localhost:8080';
const USERNAME = 'alice';
const PASSWORD = 'correct-horse-battery-staples';
// Unique per run: alice's server-side notes accumulate across E2E runs, and
// the keep-exception store is per browser profile — a stable title would
// collide with leftovers from a previous run.
const NOTE_TITLE = `E2E OIDC note ${Date.now()}`;

let serverUp: boolean | null = null;

async function pingServer(): Promise<boolean> {
  if (serverUp !== null) return serverUp;
  try {
    const res = await fetch(`${SERVER}/healthz`);
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
  return serverUp;
}

test.beforeEach(async () => {
  test.skip(!(await pingServer()), 'reference server not running on :8080');
});

/**
 * Count notes with the given title directly in the app's IndexedDB. Proves
 * never-delete at the store level, independent of what the list renders.
 */
async function countLocalNotes(
  page: import('@playwright/test').Page,
  title: string,
): Promise<number> {
  return page.evaluate(async (t) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('NotesApp');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction('notes', 'readonly');
      const all = await new Promise<unknown[]>((resolve, reject) => {
        const req = tx.objectStore('notes').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return all.filter((n) => (n as { title?: string }).title === t).length;
    } finally {
      db.close();
    }
  }, title);
}

/** Complete the OIDC flow through the server-rendered login page. */
async function oidcLogin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(APP_PATH);
  await page.getByTitle('Settings').click();
  await page.getByLabel('Sign-in server (issuer)').fill(SERVER);
  await page.getByTestId('oidc-sign-in').click();

  // The server-rendered login page (form posts to /authorize/submit).
  await page.waitForURL(/localhost:8080\/authorize/, { timeout: 15000 });
  await page.locator('input[name="username"]').fill(USERNAME);
  await page.locator('input[name="password"]').fill(PASSWORD);

  // Submit the login form.
  //
  // The reference server stamps every HTML response with a strict CSP
  // (`default-src 'none'; form-action 'self'`, server/http-utils.mjs
  // HTML_SECURITY_HEADERS). Headless Chromium blocks the form POST to
  // /authorize/submit with "violates ... form-action 'self'" whenever the
  // form carries the server's hidden `redirect_uri` field (its value is a
  // URL), and also blocks same-origin fetch() from the page under
  // `default-src 'none'` (no connect-src fallback allowed). Both are
  // Chromium-vs-strict-CSP behaviors on the SERVER's page; the app is not
  // involved. To keep this E2E about the client flow (not browser CSP
  // quirks), the credentials + hidden pending-OIDC fields are read from the
  // live form and POSTed via Playwright's API request context
  // (page.request), which shares the browser context's cookies but is not
  // subject to the page CSP. The 302 Location is then navigated to
  // normally, so the client-side callback handling runs exactly as in
  // production. Reported to the server-side owner (R1): real-browser
  // logins hit the same wall.
  const pending = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const el of document.forms[0].elements) {
      if (el instanceof HTMLInputElement && el.type === 'hidden') out[el.name] = el.value;
    }
    return out;
  });
  const response = await page.request.post(`${SERVER}/authorize/submit`, {
    form: { ...pending, username: USERNAME, password: PASSWORD },
    maxRedirects: 0,
  });
  const location = response.headers()['location'];
  expect(response.status(), 'login submit should redirect').toBe(302);
  expect(location, 'redirect must carry an auth code').toMatch(/code=/);

  // Back through /auth/callback → app root (?settings=1 returnTo).
  await page.goto(location);
  await page.waitForURL((u) => !u.pathname.endsWith('/auth/callback'), { timeout: 15000 });

  // Signed in: the account section shows the username.
  await page.getByTitle('Settings').click();
  await expect(page.getByTestId('oidc-signed-in-as')).toHaveText(USERNAME, { timeout: 15000 });
}

test('OIDC sign-in + cross-device sync + server deletion → keep on client 1, delete on client 2', async ({
  browser,
}) => {
  await step('client-1-login');

  // ── Client 1: fresh context, seed one local note, sign in. ───────────────
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  await seedNotes(page1, [makeNote({ title: NOTE_TITLE, content: '# From client 1', category: 'Work' })]);

  await oidcLogin(page1);
  await step('client-1-signed-in');

  // Server URL is auto-filled from the issuer on first sign-in; save it.
  const serverUrlValue = await page1.getByLabel('Server URL').inputValue();
  if (!serverUrlValue) {
    await page1.getByLabel('Server URL').fill(SERVER);
    await page1.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page1.getByText('Sync settings saved')).toBeVisible();
  }

  // ── Sync now: pushes the local note to the server. ───────────────────────
  await page1.getByRole('button', { name: 'Sync now' }).click();
  // Exactly one push: the seeded note (client 1 starts empty).
  await expect(page1.getByText('Sync complete — 1 pushed')).toBeVisible({ timeout: 20000 });
  await step('client-1-pushed');

  // Server-side proof: the note is in the server's data directory. The
  // server debounces its disk writes (server/store.mjs), so poll until the
  // file reflects the push instead of asserting on a single read.
  const fs = await import('fs');
  const dataDir = '/tmp/nh-r2-e2e';
  await expect
    .poll(
      () => {
        const files = fs.readdirSync(dataDir).filter((f) => f.startsWith('notes-'));
        return files.some((file) => {
          const parsed = JSON.parse(fs.readFileSync(`${dataDir}/${file}`, 'utf8'));
          const notes = parsed.notes ?? [];
          return notes.some((n: { payload?: { title?: string } }) => n.payload?.title === NOTE_TITLE);
        });
      },
      { timeout: 15000, message: 'note never appeared in the server data dir' },
    )
    .toBe(true);

  // ── Client 2: second browser context = fresh client, same user. ──────────
  await step('client-2-login-sync');
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await oidcLogin(page2);
  // Exactly one pull is NOT guaranteed (alice may carry notes from earlier
  // E2E runs), so assert on OUR note appearing rather than the summary count.
  await page2.getByRole('button', { name: 'Sync now' }).click();
  await expect(page2.getByText(/Sync complete|already up to date/)).toBeVisible({ timeout: 20000 });
  await page2.getByTitle('Back to notes').click();
  await expect(page2.getByText(NOTE_TITLE, { exact: true })).toBeVisible();

  // ── Delete the note SERVER-SIDE (as the user, via the API). ─────────────
  await step('server-side-delete');
  // Grab an access token for the API from client 2's localStorage.
  const oidcBlob = JSON.parse((await page2.evaluate(() => localStorage.getItem('notehaven.sync.oidc'))) ?? '{}');
  const token = oidcBlob.session.accessToken as string;

  // Find the uid from client 1's uidMap (the note was pushed from there).
  const uidMap1 = JSON.parse(
    (await page1.evaluate(() => localStorage.getItem('notehaven.sync.uidMap'))) ?? '{}',
  );
  const uid = Object.values(uidMap1)[0] as string;
  expect(uid).toBeTruthy();

  const del = await fetch(`${SERVER}/api/notes/${uid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // The reference server tombstones (200 + JSON body), never hard-deletes.
  expect(del.status).toBe(200);
  expect((await del.json())).toMatchObject({ ok: true, deleted: true, uid });

  // ── Client 1 syncs → notification queue appears, local note survives. ────
  await step('client-1-notification');
  await page1.getByRole('button', { name: 'Sync now' }).click();
  // The toast AND the status line both carry the summary — match the toast.
  await expect(page1.getByText(/1 deletion awaiting your choice/).first()).toBeVisible({ timeout: 20000 });

  // The bell shows the pending count.
  await expect(page1.getByTestId('sync-notifications-count')).toHaveText('1');
  await page1.getByTestId('sync-notifications-trigger').click();
  const panel = page1.getByTestId('sync-notifications-panel');
  await expect(panel).toBeVisible();
  const item = page1.getByTestId(`sync-queue-item-${uid}`);
  await expect(item).toBeVisible();
  await expect(item).toContainText(NOTE_TITLE);

  // The local note is STILL in client 1's store (never-delete) — proven at the
  // IndexedDB level, independent of what the notes list renders.
  expect(await countLocalNotes(page1, NOTE_TITLE)).toBe(1);
  await page1.getByTitle('Back to notes').click();
  await expect(page1.getByText(NOTE_TITLE, { exact: true }).first()).toBeVisible();
  await page1.getByTitle('Settings').click();

  // ── Choose KEEP → exception persisted, no re-prompt on the next sync. ────
  await step('client-1-keep');
  await page1.getByTestId('sync-notifications-trigger').click();
  await page1.getByTestId(`sync-keep-${uid}`).click();
  await expect(page1.getByTestId(`sync-queue-item-${uid}`)).toHaveCount(0);
  await expect(page1.getByTestId('sync-notifications-count')).toHaveCount(0);

  const exceptions = JSON.parse(
    (await page1.evaluate(() => localStorage.getItem('notehaven.sync.keepExceptions'))) ?? '{}',
  );
  expect(Object.keys(exceptions)).toContain(uid);

  // Sync again: no re-prompt, note still local.
  await page1.getByRole('button', { name: 'Sync now' }).click();
  // Older toasts can still be on screen — assert the newest one by position.
  await expect(page1.getByText(/Sync complete|already up to date/).last()).toBeVisible();
  await expect(page1.getByTestId('sync-notifications-count')).toHaveCount(0);
  await page1.getByTitle('Back to notes').click();
  await expect(page1.getByText(NOTE_TITLE, { exact: true }).first()).toBeVisible();

  // ── Client 2 (no exceptions): same deletion → Delete removes it locally. ──
  await step('client-2-delete');
  await page2.getByTitle('Settings').click();
  await page2.getByRole('button', { name: 'Sync now' }).click();
  await expect(page2.getByTestId('sync-notifications-count')).toHaveText('1');
  await page2.getByTestId('sync-notifications-trigger').click();
  await expect(page2.getByTestId(`sync-queue-item-${uid}`)).toBeVisible();

  // Note still there before the decision (never-delete until told) — at the
  // store level and in the UI.
  expect(await countLocalNotes(page2, NOTE_TITLE)).toBe(1);
  await page2.getByTitle('Back to notes').click();
  await expect(page2.getByText(NOTE_TITLE, { exact: true }).first()).toBeVisible();
  await page2.getByTitle('Settings').click();

  await page2.getByTestId('sync-notifications-trigger').click();
  await page2.getByTestId(`sync-delete-${uid}`).click();
  await expect(page2.getByTestId(`sync-queue-item-${uid}`)).toHaveCount(0);

  await page2.getByTitle('Back to notes').click();
  await expect(page2.getByText(NOTE_TITLE, { exact: true })).toHaveCount(0);
  expect(await countLocalNotes(page2, NOTE_TITLE)).toBe(0);
  await step('client-2-deleted');

  // Client 2 keeps its own (empty) exception set — decisions are per client.
  const exceptions2 = JSON.parse(
    (await page2.evaluate(() => localStorage.getItem('notehaven.sync.keepExceptions'))) ?? '{}',
  );
  expect(Object.keys(exceptions2)).not.toContain(uid);

  await ctx1.close();
  await ctx2.close();
});