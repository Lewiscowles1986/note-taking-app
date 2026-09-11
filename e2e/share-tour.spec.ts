import { test, expect, seedNotes, type NoteSeed, APP_PATH } from './fixtures';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Share-feature screenshot tour (PR storytelling).
 *
 * GATED exactly like docs-tour.spec.ts: runs only with E2E_SHARE_SHOTS=1 on
 * the "chromium" project — every test is skipped in normal runs, so suite
 * runtime and git state are unaffected. Captures deterministic PNGs with
 * stable semantic filenames into docs/images/share/ for attaching to the
 * share-feature PR.
 *
 * Run:  E2E_SHARE_SHOTS=1 npx playwright test e2e/share-tour.spec.ts --project=chromium
 */

const IMAGES_DIR = path.join(process.cwd(), 'docs', 'images', 'share');

test.use({ viewport: { width: 1440, height: 900 } });

/** Capture a screenshot into docs/images/share/<name>.png. */
async function shot(page: Page, name: string): Promise<string> {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const filePath = path.join(IMAGES_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, timeout: 60_000 });
  console.log(`[share-tour] ${name}: ${filePath}`);
  return filePath;
}

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

/** Share a seeded plaintext note and hand back the generated link. */
async function createShareLink(page: Page, title: string): Promise<string> {
  await page.locator('div.group', { hasText: title }).click();
  await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
  await page.getByTitle('Share this note via a link').click();
  await page.getByRole('button', { name: 'Create share link' }).click();
  return page.locator('textarea[readonly]').inputValue();
}

// ─── 1. Sender: the warning-gated plaintext dialog ──────────────────────────
test('shot: plaintext warning dialog', async ({ page }) => {
  test.skip(!process.env.E2E_SHARE_SHOTS || test.info().project.name !== 'chromium',
    'share screenshot tour runs only with E2E_SHARE_SHOTS=1 on chromium');
  await seedNotes(page, [
    makeNote({ title: 'Sourdough starter', content: '# Sourdough starter\n\n- 500g flour\n- 350g water\n- 100g starter\n\nFeed daily, keep at room temperature.', tags: ['baking'], category: 'Kitchen' }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Sourdough starter' }).click();
  await page.getByTitle('Share this note via a link').click();
  // The warning state, BEFORE the link exists.
  await expect(page.getByText(/unencrypted/i)).toBeVisible();
  await page.screenshot({ path: path.join(IMAGES_DIR, 'share-warning-plaintext.png'), timeout: 60_000 });
});

// ─── 2. Sender: link created (dialog with copy + the URL) ───────────────────
test('shot: generated link', async ({ page }) => {
  test.skip(!process.env.E2E_SHARE_SHOTS || test.info().project.name !== 'chromium',
    'share screenshot tour runs only with E2E_SHARE_SHOTS=1 on chromium');
  await seedNotes(page, [
    makeNote({ title: 'Sourdough starter', content: '# Sourdough starter\n\n- 500g flour\n- 350g water\n- 100g starter\n\nFeed daily, keep at room temperature.', tags: ['baking'], category: 'Kitchen' }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Sourdough starter' }).click();
  await page.getByTitle('Share this note via a link').click();
  await page.getByRole('button', { name: 'Create share link' }).click();
  await expect(page.locator('textarea[readonly]')).toBeVisible();
  await page.screenshot({ path: path.join(IMAGES_DIR, 'share-link-created.png'), timeout: 60_000 });
});

// ─── 3. Receiver: consent-gated preview for a plaintext link ────────────────
test('shot: receiver preview (plaintext)', async ({ page }) => {
  test.skip(!process.env.E2E_SHARE_SHOTS || test.info().project.name !== 'chromium',
    'share screenshot tour runs only with E2E_SHARE_SHOTS=1 on chromium');
  const sender = page;
  await seedNotes(sender, [
    makeNote({ title: 'Sourdough starter', content: '# Sourdough starter\n\n- 500g flour\n- 350g water\n- 100g starter\n\nFeed daily, keep at room temperature.', tags: ['baking'], category: 'Kitchen' }),
  ]);
  await sender.goto(APP_PATH);
  const link = await createShareLink(sender, 'Sourdough starter');

  const receiver = sender.context().browser()!;
  const receiverPage = await receiver.newContext().then((c) => c.newPage());
  await receiverPage.setViewportSize({ width: 1440, height: 900 });
  await receiverPage.goto(link);
  await expect(receiverPage.getByText(/plain text/i)).toBeVisible();
  // Let the lazy NoteViewer chunk load so the preview is fully rendered.
  await expect(receiverPage.getByRole('heading', { name: 'Sourdough starter', level: 1 })).toBeVisible();
  await receiverPage.screenshot({ path: path.join(IMAGES_DIR, 'share-receiver-preview.png'), timeout: 60_000 });
  await receiverPage.context().close();
});

// ─── 4. Sender: encrypted note shares ciphertext only ───────────────────────
test('shot: encrypted link dialog', async ({ page }) => {
  test.skip(!process.env.E2E_SHARE_SHOTS || test.info().project.name !== 'chromium',
    'share screenshot tour runs only with E2E_SHARE_SHOTS=1 on chromium');
  await seedNotes(page, [
    makeNote({ title: 'Recovery codes', content: 'plan body\n\ncode 1111-2222\ncode 3333-4444', tags: ['secret'], category: 'Private' }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Recovery codes' }).click();
  await page.getByTitle('Encrypt this note').click();
  await page.getByPlaceholder('Min 8 characters').fill('storyteller-password');
  await page.getByPlaceholder('Confirm password').fill('storyteller-password');
  await page.getByRole('button', { name: /encrypt note/i }).click();
  await expect(page.getByTitle('Encrypted — click to manage')).toBeVisible();

  await page.getByTitle('Share this note via a link').click();
  await expect(page.getByText(/carries only the ciphertext/i)).toBeVisible();
  await page.screenshot({ path: path.join(IMAGES_DIR, 'share-encrypted-ciphertext-only.png'), timeout: 60_000 });
});

// ─── 5. Receiver: saved encrypted note arrives locked ───────────────────────
test('shot: receiver locked note', async ({ page }) => {
  test.skip(!process.env.E2E_SHARE_SHOTS || test.info().project.name !== 'chromium',
    'share screenshot tour runs only with E2E_SHARE_SHOTS=1 on chromium');
  await seedNotes(page, [
    makeNote({ title: 'Recovery codes', content: 'plan body\n\ncode 1111-2222', tags: ['secret'], category: 'Private' }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Recovery codes' }).click();
  await page.getByTitle('Encrypt this note').click();
  await page.getByPlaceholder('Min 8 characters').fill('storyteller-password');
  await page.getByPlaceholder('Confirm password').fill('storyteller-password');
  await page.getByRole('button', { name: /encrypt note/i }).click();
  await expect(page.getByTitle('Encrypted — click to manage')).toBeVisible();
  await page.getByTitle('Share this note via a link').click();
  const linkValue = await page.locator('textarea[readonly]').inputValue();

  const receiverPage = await page.context().browser()!.newContext().then((c) => c.newPage());
  await receiverPage.setViewportSize({ width: 1440, height: 900 });
  await receiverPage.goto(linkValue);
  await expect(receiverPage.getByText(/carries only ciphertext/i)).toBeVisible();
  await receiverPage.getByRole('button', { name: /save encrypted note/i }).click();
  // Saved as locked — capture the locked editor the recipient sees.
  await expect(receiverPage.getByRole('button', { name: 'Unlock Note' })).toBeVisible();
  await receiverPage.screenshot({ path: path.join(IMAGES_DIR, 'share-receiver-locked.png'), timeout: 60_000 });
  await receiverPage.context().close();
});