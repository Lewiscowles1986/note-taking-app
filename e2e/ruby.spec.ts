import { test, expect, seedNotes, step, type NoteSeed, APP_PATH } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Ruby wasm runner acceptance. Mirrors the PHP code-block test: seed a note with
 * a ruby block, switch to View, pick a version, run it, and assert real output
 * from the vendored build.
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

test('runs a Ruby code block via wasm and shows the vendored version', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Ruby',
      content: '# Ruby\n\n```ruby\nputs "Hello from Ruby #{RUBY_VERSION}"\n```',
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Ruby' }).click();
  await expect(editor(page)).toHaveValue(/# Ruby/);
  await step(page, 'ruby-block');

  await page.getByRole('button', { name: 'View', exact: true }).click();

  // Ruby is a versioned runner, so the selector must appear with the real
  // version from the bundle manifest (not a series label that 404s).
  const versionSelect = page.getByRole('combobox', { name: 'ruby version' });
  await expect(versionSelect).toBeVisible({ timeout: 10000 });
  await expect(versionSelect).toHaveValue('4.0.0');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Hello from Ruby 4\.0\.0/)).toBeVisible({ timeout: 60000 });
  await step(page, 'ruby-output');
});
