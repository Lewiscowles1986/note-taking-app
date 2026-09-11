import { test, expect, step, seedNotes, debugBreak, type NoteSeed, APP_PATH } from './fixtures';

/**
 * Share-via-URL e2e: a note is shared from one browser context, the link is
 * opened in a *second* context (a different "device"), and the received note
 * is saved and verified — the full sender → link → receiver loop with no
 * server beyond the static app shell.
 *
 * Encrypted notes are covered too: the link must carry only ciphertext, and
 * the receiver saves a note that stays locked until the password is entered.
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

test('share a plaintext note: link opens in a second context and saves', async ({ page, browser }) => {
  await seedNotes(page, [
    makeNote({ title: 'Recipe', content: '# Sourdough\n\n- flour\n- water', tags: ['baking'] }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('Recipe', { exact: true })).toBeVisible();

  // Open the note (selection is not automatic on load), then share it.
  await page.locator('div.group', { hasText: 'Recipe' }).click();
  await expect(page.getByRole('heading', { name: 'Recipe', level: 2 })).toBeVisible();

  // Open the share dialog from the meta bar.
  await page.getByTitle('Share this note via a link').click();
  // Plaintext notes require the explicit create-link click behind a warning.
  await expect(page.getByText(/unencrypted/i)).toBeVisible();
  await debugBreak(page, 'share dialog open — warning shown, no link yet');
  await page.getByRole('button', { name: 'Create share link' }).click();

  const linkValue = await page.locator('textarea[readonly]').inputValue();
  expect(linkValue).toContain('?note=');
  await step(page, 'link created');

  // Copy + close, then open the link in a fresh context = another device.
  const receiver = await browser.newContext();
  const receiverPage = await receiver.newPage();
  await receiverPage.goto(linkValue);

  // Consent-gated receiver: preview first, nothing stored yet.
  await expect(receiverPage.getByText('Recipe')).toBeVisible();
  await expect(receiverPage.getByText(/plain text/i)).toBeVisible();

  // Prove nothing was written before the explicit save.
  await receiverPage.reload();
  await expect(receiverPage.getByText(/plain text/i)).toBeVisible();

  await receiverPage.getByRole('button', { name: /save to my notes/i }).click();
  // Save lands on /?open=<id>, which Index consumes (replacing the URL) by
  // selecting the note — assert the end state: note open in the editor.
  await expect(receiverPage.getByRole('heading', { name: 'Recipe', level: 2 })).toBeVisible();
  await expect(receiverPage.locator('textarea, [contenteditable]').first()).toContainText('Sourdough');
  await step(page, 'received and saved');
  await receiver.close();
});

test('share an encrypted note: link carries ciphertext only, receiver stays locked', async ({ page, browser }) => {
  // Seed a plaintext note, then encrypt it through the app UI so the payload
  // shape is exactly canonical and the receiver unlock reveals real content.
  await seedNotes(page, [
    makeNote({ title: 'Secret plan', content: 'plan body', tags: [] }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('Secret plan', { exact: true })).toBeVisible();

  // Open the note, then encrypt through the app UI so the payload shape is
  // exactly canonical.
  await page.locator('div.group', { hasText: 'Secret plan' }).click();
  await expect(page.getByRole('heading', { name: 'Secret plan', level: 2 })).toBeVisible();
  await page.getByTitle('Encrypt this note').click();
  await page.getByPlaceholder('Min 8 characters').fill('e2e-share-password');
  await page.getByPlaceholder('Confirm password').fill('e2e-share-password');
  await page.getByRole('button', { name: /encrypt note/i }).click();
  await expect(page.getByTitle('Encrypted — click to manage')).toBeVisible();
  await step(page, 'note encrypted');

  // Share it: encrypted links build immediately (no create-link gate).
  await page.getByTitle('Share this note via a link').click();
  await expect(page.getByText(/carries only the ciphertext/i)).toBeVisible();
  const linkValue = await page.locator('textarea[readonly]').inputValue();
  expect(linkValue).toContain('?note=');
  // The password and any plaintext must not appear in the link.
  expect(linkValue).not.toContain('e2e-share-password');
  await page.keyboard.press('Escape');
  await step(page, 'encrypted link built');

  // Receiver side.
  const receiver = await browser.newContext();
  const receiverPage = await receiver.newPage();
  await receiverPage.goto(linkValue);

  // Encrypted banner + optional preview UI; save keeps it locked.
  await expect(receiverPage.getByText(/carries only ciphertext/i)).toBeVisible();
  await receiverPage.getByRole('button', { name: /save encrypted note/i }).click();
  // Saved as locked — the editor shows the locked state, never the plaintext.
  await expect(receiverPage.getByRole('heading', { name: 'Secret plan', level: 2 })).toBeVisible();
  await expect(receiverPage.getByRole('button', { name: 'Unlock Note' })).toBeVisible();

  // The note must be locked in the receiver's DB: unlock with the password.
  await receiverPage.getByRole('button', { name: 'Unlock Note' }).click();
  await receiverPage.getByPlaceholder('Enter password').first().fill('e2e-share-password');
  await receiverPage.getByRole('button', { name: /decrypt note/i }).click();
  // After unlocking, the editor textarea holds the decrypted plaintext.
  await expect(
    receiverPage.getByPlaceholder('Start writing... Type / for commands'),
  ).toHaveValue('plan body');
  await step(page, 'receiver unlocked with password');
  await receiver.close();
});