import { test, expect, step, seedNotes, type NoteSeed } from './fixtures';
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
