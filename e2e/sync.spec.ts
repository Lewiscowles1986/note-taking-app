import { test, expect, step, seedNotes, debugBreak, type NoteSeed, APP_PATH } from './fixtures';
import type { Page, Route } from '@playwright/test';

/**
 * Sync settings suite. Covers the settings page (gear icon in the header):
 * server configuration persistence, connection test, a full two-way sync
 * round against a MOCKED REST server (page.route), pull into the note list,
 * and deletion propagation via the tombstone flow.
 *
 * The mock server implements the protocol from docs/sync.md:
 *   GET    /api/notes        → manifest
 *   GET    /api/notes/{uid}  → note payload
 *   PUT    /api/notes/{uid}  → upsert
 *   DELETE /api/notes/{uid}  → tombstone
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

const SERVER = 'https://sync.test';

/** In-memory remote store + route wiring for the mocked sync server. */
function installMockServer(page: Page) {
  // uid -> payload. Seeded by tests before the first sync.
  const remote = new Map<string, Record<string, unknown>>();
  const deleted = new Set<string>();
  const puts: Record<string, unknown>[] = [];
  const deletes: string[] = [];

  const manifest = () =>
    Array.from(remote.keys()).map((uid) => ({
      uid,
      updatedAt: remote.get(uid)!.updatedAt,
      deleted: deleted.has(uid) || undefined,
    }));

  const iso = (d: Date) => d.toISOString();

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean); // [api, notes, uid?]
    const method = request.method();

    // CORS: the app (localhost) talks to a "remote" server, so behave like a
    // real CORS-enabled endpoint — answer preflights and tag real responses.
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    };
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }

    if (parts.length === 2 && method === 'GET') {
      await route.fulfill({ json: { notes: manifest() }, headers: corsHeaders });
      return;
    }
    const uid = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') {
      const note = remote.get(uid);
      if (!note) {
        await route.fulfill({ status: 404, json: { error: 'not found' }, headers: corsHeaders });
      } else {
        await route.fulfill({ json: note, headers: corsHeaders });
      }
      return;
    }
    if (method === 'PUT') {
      const body = request.postDataJSON() as Record<string, unknown>;
      puts.push(body);
      remote.set(uid, body);
      deleted.delete(uid);
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    if (method === 'DELETE') {
      deletes.push(uid);
      remote.delete(uid);
      deleted.add(uid);
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    await route.fulfill({ status: 405, json: { error: 'method not allowed' }, headers: corsHeaders });
  };

  void page.route(`${SERVER}/api/notes**`, handle);
  return {
    remote,
    deleted,
    puts,
    deletes,
    iso,
    /** Seed a note on the "server" before the app syncs. */
    seed(uid: string, note: Record<string, unknown>) {
      remote.set(uid, note);
      deleted.delete(uid);
    },
  };
}

/** Configure + save the connection through the UI (settings page open). */
async function configureServer(page: Page, token = ''): Promise<void> {
  await page.getByLabel('Server URL').fill(SERVER);
  if (token) await page.getByLabel('Access token (optional)').fill(token);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Sync settings saved')).toBeVisible();
}

test('settings page opens from the header and persists configuration', async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(page.getByRole('heading', { name: 'No note selected' })).toBeVisible();
  await debugBreak(page, 'app loaded — inspect before opening settings');

  await page.getByTitle('Settings').click();
  await expect(page.getByText('Sync server')).toBeVisible();
  await step(page, 'settings-open');

  await configureServer(page, 'e2e-token');

  // Persisted: reload and confirm the fields survive.
  await page.reload();
  await page.getByTitle('Settings').click();
  await expect(page.getByLabel('Server URL')).toHaveValue(SERVER);
  await expect(page.getByLabel('Access token (optional)')).toHaveValue('e2e-token');
  await step(page, 'settings-persisted');
});

test('connection test reaches the mocked server and reports the note count', async ({ page }) => {
  const server = installMockServer(page);
  server.seed('remote-1', { uid: 'remote-1', updatedAt: new Date().toISOString(), title: 'x' });

  await page.goto(APP_PATH);
  await page.getByTitle('Settings').click();
  await configureServer(page);

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Connection OK — 1 note on server')).toBeVisible();
  await step(page, 'connection-tested');
});

test('sync pushes a local note to the server (two-way merge, push path)', async ({ page }) => {
  const server = installMockServer(page);
  await seedNotes(page, [makeNote({ title: 'PushMe', content: '# PushMe\n\nlocal body' })]);
  await page.goto(APP_PATH);
  await expect(page.getByText('PushMe', { exact: true })).toBeVisible();

  await page.getByTitle('Settings').click();
  await configureServer(page);
  await debugBreak(page, 'configured — inspect before sync');

  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Sync complete — 1 pushed')).toBeVisible();
  await step(page, 'synced-push');

  expect(server.puts).toHaveLength(1);
  expect(server.puts[0].title).toBe('PushMe');
  expect(server.puts[0].content).toContain('local body');
  // Status line reflects the recorded outcome.
  await expect(page.getByTestId('sync-last-status')).toContainText('1 pushed');
});

test('sync pulls a server-only note into the note list', async ({ page }) => {
  const server = installMockServer(page);
  const now = new Date().toISOString();
  server.seed('srv-note-1', {
    uid: 'srv-note-1',
    title: 'FromServer',
    content: '# FromServer\n\npulled body',
    tags: ['remote'],
    category: 'General',
    attachments: [],
    createdAt: now,
    updatedAt: now,
    editDates: [],
    pinned: false,
    encrypted: null,
  });

  await page.goto(APP_PATH);
  await page.getByTitle('Settings').click();
  await configureServer(page);

  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Sync complete — 1 pulled')).toBeVisible();
  await step(page, 'synced-pull');

  // Back to notes: the pulled note is in the list.
  await page.getByTitle('Back to notes').click();
  await expect(page.getByText('FromServer', { exact: true })).toBeVisible();
  await step(page, 'pulled-note-in-list');
});

test('deleting a local note deletes it on the server at the next sync', async ({ page }) => {
  const server = installMockServer(page);
  await seedNotes(page, [makeNote({ title: 'Doomed', content: 'x' })]);
  await page.goto(APP_PATH);
  await expect(page.getByText('Doomed', { exact: true })).toBeVisible();

  // First sync: pushes the note and establishes its uid.
  await page.getByTitle('Settings').click();
  await configureServer(page);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Sync complete — 1 pushed')).toBeVisible();
  expect(server.puts).toHaveLength(1);

  // Delete it back in notes view (hover reveals the trash button).
  await page.getByTitle('Back to notes').click();
  const doomedItem = page.locator('div.group', { hasText: 'Doomed' });
  await doomedItem.hover();
  await doomedItem.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Doomed', { exact: true })).toBeHidden();
  await debugBreak(page, 'note deleted locally — inspect before second sync');

  // Second sync: the tombstone propagates as a server-side delete.
  await page.getByTitle('Settings').click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText(/Sync complete.*1 deleted on server/)).toBeVisible();
  expect(server.deletes).toHaveLength(1);
  expect(server.remote.size).toBe(0);
  await step(page, 'synced-delete');
});

test('forget server clears the stored connection', async ({ page }) => {
  await page.goto(APP_PATH);
  await page.getByTitle('Settings').click();
  await configureServer(page);

  await page.getByRole('button', { name: 'Forget server' }).click();
  await expect(page.getByText('Server connection forgotten')).toBeVisible();
  await expect(page.getByLabel('Server URL')).toHaveValue('');
  await step(page, 'server-forgotten');
});