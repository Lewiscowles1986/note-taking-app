import { test, expect, step, seedNotes, debugBreak, type NoteSeed } from './fixtures';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Round D encryption suite. Covers password-based encrypt/lock, wrong-password
 * rejection, correct-password unlock/decrypt, and (optionally) the RSA key-pair
 * flow. Reads the real EncryptionDialog/useEncryption/crypto.ts behavior.
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
    editDates: ['2024-01-01'],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

const editor = (page: Page) => page.getByPlaceholder('Start writing... Type / for commands');
const dialog = (page: Page) => page.locator('div.fixed.inset-0.z-50');

const PASSWORD = 'correct horse battery staple';

/** Seed + open a note, then encrypt it with a password via the dialog. */
async function seedAndEncrypt(
  page: Page,
  title: string,
  content: string,
  password: string,
): Promise<void> {
  await seedNotes(page, [makeNote({ title, content })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await page.getByPlaceholder('Min 8 characters').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Encrypt Note' }).click();
  await expect(page.getByText('Note encrypted')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
}

test('encrypts a note with a password and locks it', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Secret', content: '# Secret\n\nTop secret body' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Secret' }).click();
  await expect(page.getByRole('heading', { name: 'Secret', level: 2 })).toBeVisible();

  // Open the encryption dialog from the meta bar.
  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await debugBreak(page, 'encrypt dialog open — inspect before encrypting');
  await step(page, 'encrypt-dialog');

  await page.getByPlaceholder('Min 8 characters').fill(PASSWORD);
  await page.getByPlaceholder('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Encrypt Note' }).click();

  // Success toast + locked UI.
  await expect(page.getByText('Note encrypted')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock Note' })).toBeVisible();
  // Lock icon in the top-bar header (the only lock with the text-primary class).
  await expect(page.locator('svg.lucide-lock.text-primary')).toBeVisible();
  await step(page, 'locked');
});

test('rejects the wrong password on unlock', async ({ page }) => {
  await seedAndEncrypt(page, 'Secret', '# Secret\n\nTop secret body', PASSWORD);
  await debugBreak(page, 'note encrypted — inspect before wrong-password unlock');

  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await expect(page.getByPlaceholder('Enter password')).toBeVisible();
  await page.getByPlaceholder('Enter password').fill('wrong password');
  await page.getByRole('button', { name: 'Decrypt Note' }).click();

  // APP BUG: WebCrypto's AES-CBC decrypt failure throws an OperationError with
  // an EMPTY message, and EncryptionDialog renders its error banner only when
  // `error` is truthy — so a wrong password produces NO visible error message.
  // The note must still be locked, which is the behavior we assert here.
  // The dialog stays open (handleDecrypt does not close on error).
  await expect(page.getByRole('button', { name: 'Decrypt Note' })).toBeVisible();
  await step(page, 'wrong-password');

  // Close the dialog: the note is still locked.
  await dialog(page).locator('button:has(svg.lucide-x)').click();
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock Note' })).toBeVisible();
});

test('unlocks and decrypts with the correct password', async ({ page }) => {
  await seedAndEncrypt(page, 'Secret', '# Secret\n\nTop secret body', PASSWORD);
  await debugBreak(page, 'note encrypted — inspect before correct-password unlock');

  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await page.getByPlaceholder('Enter password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Decrypt Note' }).click();

  // handleDecrypt saves plaintext and clears the encrypted flag.
  await expect(page.getByText('Note decrypted')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeHidden();
  await expect(page.locator('svg.lucide-lock')).toHaveCount(0);
  await expect(editor(page)).toHaveValue(/# Secret\n\nTop secret body/);
  await step(page, 'unlocked');
});

test('encrypts and decrypts with a generated key pair', async ({ page }) => {
  test.setTimeout(120_000);
  await seedNotes(page, [makeNote({ title: 'KeyNote', content: '# KeyNote\n\nKey body' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'KeyNote' }).click();
  await expect(page.getByRole('heading', { name: 'KeyNote', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();

  // Generate an RSA-4096 key pair (can take several seconds).
  await dialog(page).getByRole('button', { name: 'Key Pairs' }).click();
  await page.getByPlaceholder('Key pair name').fill('my-key');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('my-key', { exact: true })).toBeVisible({ timeout: 60_000 });
  await debugBreak(page, 'key pair generated — inspect before encrypting');

  // Encrypt with the key pair.
  await dialog(page).getByRole('button', { name: 'Encrypt', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Key Pair', exact: true }).click();
  // APP BUG: a freshly generated key is NOT auto-selected — selectedKeyId stays
  // '' even though the dropdown visually shows the key, so "Encrypt Note" would
  // fail with "Select a key pair". Select it explicitly from the dropdown.
  await dialog(page).locator('select').selectOption({ index: 0 });
  await page.getByRole('button', { name: 'Encrypt Note' }).click();
  // RSA-4096 wrapKey is slow; allow generous time for the encrypt + toast.
  await expect(page.getByText('Note encrypted')).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();

  // Unlock: keypair decrypt needs no password — the stored private key is used.
  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  await expect(page.getByText('Note decrypted')).toBeVisible({ timeout: 20000 });
  await expect(editor(page)).toHaveValue(/# KeyNote\n\nKey body/);
  await step(page, 'keypair-unlocked');
});

test('exports a generated key pair as JWK', async ({ page }) => {
  test.setTimeout(120_000);
  await seedNotes(page, [makeNote({ title: 'KeyExport', content: '# KeyExport\n\nBody' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'KeyExport' }).click();
  await expect(page.getByRole('heading', { name: 'KeyExport', level: 2 })).toBeVisible();

  // Open the encryption dialog and generate an RSA-4096 key pair.
  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Key Pairs' }).click();
  await page.getByPlaceholder('Key pair name').fill('export-key');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('export-key', { exact: true })).toBeVisible({ timeout: 60_000 });
  await debugBreak(page, 'key pair generated — inspect before export');
  await step(page, 'keypair-generated');

  // Export the key pair as JWK via the row's "Export as JWK" control.
  const downloadPromise = page.waitForEvent('download');
  await dialog(page).getByTitle('Export as JWK').click();
  const download = await downloadPromise;

  const suggested = download.suggestedFilename();
  expect(suggested).toBe('export-key-keys.json');

  const downloadsDir = path.join(process.cwd(), 'e2e', 'artifacts', 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, suggested);
  await download.saveAs(savePath);

  // JWK export: the JSON must carry publicKey + privateKey members.
  const parsed = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  expect(parsed.publicKey).toBeDefined();
  expect(parsed.privateKey).toBeDefined();
  expect(parsed.publicKey.kty).toBe('RSA');
  expect(parsed.privateKey.kty).toBe('RSA');
  await step(page, 'keypair-exported');
});

// ─── Round H: deep encryption/decryption suite ─────────────────────────────

const PASSWORD_A = 'alpha password 123';
const PASSWORD_B = 'beta password 456';

/** Read a note record straight from IndexedDB (by id) for DB-level assertions. */
async function readNoteFromDb(page: Page, id: number): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(async (id) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('NotesApp', 40);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('notes', 'readonly');
        const store = tx.objectStore('notes');
        const get = store.get(id);
        get.onsuccess = () => {
          db.close();
          resolve(get.result);
        };
        get.onerror = () => {
          db.close();
          reject(get.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
  }, id);
}

/** Fill the password method and encrypt; waits for the locked UI. */
async function encryptWithPassword(page: Page, password: string): Promise<void> {
  await page.getByPlaceholder('Min 8 characters').fill(password);
  await page.getByPlaceholder('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Encrypt Note' }).click();
  await expect(page.getByText('Note encrypted')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
}

/** Unlock a password-encrypted note and wait for the decrypted editor. */
async function unlockWithPassword(page: Page, password: string): Promise<void> {
  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await page.getByPlaceholder('Enter password').fill(password);
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  await expect(page.getByText('Note decrypted')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeHidden();
}

test('roundtrips content exactly through password encrypt and decrypt', async ({ page }) => {
  test.setTimeout(120_000);
  const rich = `# Heading

Some **bold** and *italic* text.

- item one
- item two
- item three

\`\`\`js
const greeting = 'hello';
console.log(greeting);
\`\`\`

> A blockquote line.`;
  await seedNotes(page, [makeNote({ title: 'Roundtrip', content: rich })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Roundtrip' }).click();
  await expect(page.getByRole('heading', { name: 'Roundtrip', level: 2 })).toBeVisible();
  await step(page, 'original');

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await encryptWithPassword(page, PASSWORD);
  await step(page, 'encrypted');

  await unlockWithPassword(page, PASSWORD);
  await debugBreak(page, 'roundtrip decrypted — inspect editor before asserting');
  await expect(editor(page)).toHaveValue(rich, { timeout: 20_000 });
  await step(page, 'decrypted');
});

test('keeps an encrypted note locked across reload', async ({ page }) => {
  test.setTimeout(120_000);
  await seedAndEncrypt(page, 'Persist', '# Persist\n\nSecret body', PASSWORD);
  await step(page, 'encrypted-before-reload');

  await page.reload();
  await page.locator('div.group', { hasText: 'Persist' }).click();
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock Note' })).toBeVisible();
  await expect(page.locator('svg.lucide-lock.text-primary')).toBeVisible();
  await debugBreak(page, 'locked after reload — inspect before DB assertions');
  await step(page, 'locked-after-reload');

  // DB-level: content is the '[encrypted]' marker and an encrypted payload exists.
  await expect
    .poll(async () => {
      const note = await readNoteFromDb(page, 1);
      return note?.content;
    }, { timeout: 20_000 })
    .toBe('[encrypted]');
  await expect
    .poll(async () => {
      const note = await readNoteFromDb(page, 1);
      return !!note?.encrypted;
    }, { timeout: 20_000 })
    .toBe(true);
});

test('hides plaintext from the sidebar for encrypted notes', async ({ page }) => {
  test.setTimeout(120_000);
  await seedNotes(page, [
    makeNote({ title: 'Public', content: 'Public body text here' }),
    makeNote({ title: 'Secret', content: '# Secret\n\nTop secret body' }),
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Secret' }).click();
  await expect(page.getByRole('heading', { name: 'Secret', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await encryptWithPassword(page, PASSWORD);
  await debugBreak(page, 'one note encrypted — inspect sidebar before asserting');
  await step(page, 'sidebar-mixed');

  const secretRow = page.locator('div.group', { hasText: 'Secret' });
  const publicRow = page.locator('div.group', { hasText: 'Public' });
  // Encrypted note: sidebar preview is the stripped '[encrypted]' marker.
  await expect(secretRow.getByText('encrypted')).toBeVisible();
  // Plain note: normal preview, no 'encrypted' text.
  await expect(publicRow.getByText('Public body text here')).toBeVisible();
  await expect(publicRow.getByText('encrypted')).toHaveCount(0);
});

test('clears the encrypted flag after successful decrypt', async ({ page }) => {
  test.setTimeout(120_000);
  await seedAndEncrypt(page, 'ClearFlag', '# ClearFlag\n\nBody', PASSWORD);
  await unlockWithPassword(page, PASSWORD);
  await debugBreak(page, 'decrypted — inspect before DB assertions');
  await step(page, 'db-decrypted');

  await expect
    .poll(async () => {
      const note = await readNoteFromDb(page, 1);
      return note?.encrypted;
    }, { timeout: 20_000 })
    .toBe(null);
  await expect
    .poll(async () => {
      const note = await readNoteFromDb(page, 1);
      return note?.content;
    }, { timeout: 20_000 })
    .toBe('# ClearFlag\n\nBody');
});

test('recovers from a wrong password within the same dialog session', async ({ page }) => {
  test.setTimeout(120_000);
  await seedAndEncrypt(page, 'Recover', '# Recover\n\nBody', PASSWORD);
  await debugBreak(page, 'encrypted — inspect before wrong-then-right unlock');

  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await page.getByPlaceholder('Enter password').fill('wrong password');
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  // Wait for the PBKDF2 attempt to finish (button re-enables after loading).
  await expect(page.getByRole('button', { name: 'Decrypt Note' })).toBeEnabled({ timeout: 20_000 });
  // APP BUG: wrong password produces no error banner (empty OperationError message).
  // The dialog stays open and the note stays locked.
  await expect(page.getByRole('button', { name: 'Decrypt Note' })).toBeVisible();
  await step(page, 'wrong-then-right');

  // Enter the correct password in the SAME dialog (do not close/reopen).
  await page.getByPlaceholder('Enter password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  await expect(page.getByText('Note decrypted')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeHidden();
  await expect(editor(page)).toHaveValue(/# Recover\n\nBody/);
});

test('exports a generated key pair as PEM', async ({ page }) => {
  test.setTimeout(120_000);
  await seedNotes(page, [makeNote({ title: 'PemExport', content: '# PemExport\n\nBody' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'PemExport' }).click();
  await expect(page.getByRole('heading', { name: 'PemExport', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Key Pairs' }).click();
  await page.getByPlaceholder('Key pair name').fill('pem-key');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('pem-key', { exact: true })).toBeVisible({ timeout: 60_000 });
  await debugBreak(page, 'key pair generated — inspect before PEM export');
  await step(page, 'pem-export-dialog');

  const downloadPromise = page.waitForEvent('download');
  await dialog(page).getByTitle('Export as PEM').click();
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  expect(suggested).toBe('pem-key-keys.pem');

  const downloadsDir = path.join(process.cwd(), 'e2e', 'artifacts', 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, suggested);
  await download.saveAs(savePath);
  const pem = fs.readFileSync(savePath, 'utf8');
  expect(pem).toContain('BEGIN');
  expect(pem).toContain('KEY');
  expect(pem).toContain('PUBLIC KEY');
  expect(pem).toContain('PRIVATE KEY');
  await step(page, 'pem-exported');
});

test('imports an exported JWK key pair and encrypts with it', async ({ page }) => {
  test.setTimeout(180_000);
  await seedNotes(page, [makeNote({ title: 'ImportNote', content: '# ImportNote\n\nImported body' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'ImportNote' }).click();
  await expect(page.getByRole('heading', { name: 'ImportNote', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Key Pairs' }).click();

  // Generate a source key pair and export it as JWK.
  await page.getByPlaceholder('Key pair name').fill('src-key');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('src-key', { exact: true })).toBeVisible({ timeout: 60_000 });

  const downloadPromise = page.waitForEvent('download');
  await dialog(page).getByTitle('Export as JWK').click();
  const download = await downloadPromise;
  const downloadsDir = path.join(process.cwd(), 'e2e', 'artifacts', 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, download.suggestedFilename());
  await download.saveAs(savePath);
  const jwkJson = fs.readFileSync(savePath, 'utf8');
  const parsed = JSON.parse(jwkJson);
  expect(parsed.publicKey).toBeDefined();
  expect(parsed.privateKey).toBeDefined();

  // Import via the paste flow under a new name.
  await dialog(page).getByRole('button', { name: 'Import key pair' }).click();
  await page.getByPlaceholder('Name for imported key').fill('imported-key');

  // APP BUG / UX: PEM paste is not supported — handleImportKeys throws
  // 'Invalid format. Paste JWK JSON...' which surfaces in the dialog banner.
  await page
    .getByPlaceholder(/Paste JWK JSON/)
    .fill('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----');
  await dialog(page).getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog(page).getByText(/Invalid format\. Paste JWK JSON/)).toBeVisible();

  // Now paste the real JWK JSON and import successfully.
  await page.getByPlaceholder(/Paste JWK JSON/).fill(jwkJson);
  await dialog(page).getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Key pair imported')).toBeVisible();
  await expect(page.getByText('imported-key', { exact: true })).toBeVisible();
  await debugBreak(page, 'imported key present — inspect before encrypting');
  await step(page, 'imported');

  // Encrypt the note with the imported key.
  await dialog(page).getByRole('button', { name: 'Encrypt', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Key Pair', exact: true }).click();
  // APP BUG: freshly imported key is not auto-selected — select explicitly.
  // The imported key is the second option (src-key was generated first).
  await dialog(page).locator('select').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Encrypt Note' }).click();
  await expect(page.getByText('Note encrypted')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeVisible();
  await step(page, 'encrypted-imported');

  // Decrypt with the imported key (no password needed).
  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  await expect(page.getByText('Note decrypted')).toBeVisible({ timeout: 20_000 });
  await expect(editor(page)).toHaveValue(/# ImportNote\n\nImported body/);
  await step(page, 'decrypted-imported');
});

test('deletes a key pair and falls back to the select-a-key guard', async ({ page }) => {
  test.setTimeout(180_000);
  await seedNotes(page, [makeNote({ title: 'KeyGuard', content: '# KeyGuard\n\nBody' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'KeyGuard' }).click();
  await expect(page.getByRole('heading', { name: 'KeyGuard', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Key Pairs' }).click();

  // Generate two key pairs.
  await page.getByPlaceholder('Key pair name').fill('key-one');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('key-one', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder('Key pair name').fill('key-two');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByText('key-two', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Delete one key pair; the list updates to a single key.
  const keyOneRow = dialog(page).locator('div.flex.items-center.justify-between', { hasText: 'key-one' });
  await keyOneRow.getByTitle('Delete').click();
  await expect(page.getByText('key-one', { exact: true })).toHaveCount(0);
  await expect(page.getByText('key-two', { exact: true })).toBeVisible();
  await step(page, 'key-deleted');

  // Delete the remaining key pair; the list shows the empty state.
  const keyTwoRow = dialog(page).locator('div.flex.items-center.justify-between', { hasText: 'key-two' });
  await keyTwoRow.getByTitle('Delete').click();
  await expect(page.getByText('No key pairs stored yet')).toBeVisible();
  await debugBreak(page, 'all keys deleted — inspect before guard assertion');

  // With zero keys, selecting Key Pair method and clicking Encrypt shows the guard.
  await dialog(page).getByRole('button', { name: 'Encrypt', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Key Pair', exact: true }).click();
  await page.getByRole('button', { name: 'Encrypt Note' }).click();
  await expect(dialog(page).getByText('Select a key pair')).toBeVisible();
  await step(page, 'guard');
});

test('re-encrypts a decrypted note with a different password', async ({ page }) => {
  test.setTimeout(180_000);
  await seedAndEncrypt(page, 'ReEncrypt', '# ReEncrypt\n\nBody', PASSWORD_A);

  // Decrypt with password A.
  await unlockWithPassword(page, PASSWORD_A);

  // Re-encrypt with password B.
  await page.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Note Encryption' })).toBeVisible();
  await encryptWithPassword(page, PASSWORD_B);
  await step(page, 're-encrypted');

  // Old password A now fails (stays locked, no banner).
  await page.getByRole('button', { name: 'Unlock Note' }).click();
  await page.getByPlaceholder('Enter password').fill(PASSWORD_A);
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  await expect(page.getByRole('button', { name: 'Decrypt Note' })).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Decrypt Note' })).toBeVisible();
  await debugBreak(page, 'old password failed — inspect before new password');
  await step(page, 'old-password-fails');

  // New password B succeeds in the same dialog.
  await page.getByPlaceholder('Enter password').fill(PASSWORD_B);
  await page.getByRole('button', { name: 'Decrypt Note' }).click();
  await expect(page.getByText('Note decrypted')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Note is Encrypted' })).toBeHidden();
  await expect(editor(page)).toHaveValue(/# ReEncrypt\n\nBody/);
  await step(page, 'new-password-works');
});

test('deletes an encrypted note while locked', async ({ page }) => {
  test.setTimeout(120_000);
  await seedAndEncrypt(page, 'DeleteLocked', '# DeleteLocked\n\nBody', PASSWORD);
  await debugBreak(page, 'encrypted note locked — inspect before deleting');
  await step(page, 'locked-before-delete');

  // Hover the note row to reveal the delete control, then delete it.
  const row = page.locator('div.group', { hasText: 'DeleteLocked' });
  await row.hover();
  await row.getByTitle('Delete').click();

  // Note is gone and the count decremented.
  await expect(page.locator('div.group', { hasText: 'DeleteLocked' })).toHaveCount(0);
  await expect(page.getByText('0 notes · Stored locally')).toBeVisible();
  await step(page, 'deleted-locked');
});
