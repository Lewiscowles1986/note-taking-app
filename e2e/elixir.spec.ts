import { test, expect, seedNotes, step, type NoteSeed, APP_PATH } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Elixir wasm runner acceptance: seed a note with an elixir block, switch to
 * View, run it, and assert real output from the vendored BEAM build.
 */

function makeNote(overrides: Partial<NoteSeed> = {}): NoteSeed {
  const now = new Date();
  return {
    title: 'Untitled', content: '', tags: [], category: 'General', attachments: [],
    createdAt: now, updatedAt: now, editDates: ['2024-01-01'], pinned: false, encrypted: null,
    ...overrides,
  };
}

const editor = (page: Page) => page.getByPlaceholder('Start writing... Type / for commands');

test('runs an Elixir code block via wasm', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Elixir',
      content: '# Elixir\n\n```elixir\nIO.puts("Hello from Elixir #{System.version()}")\n```',
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Elixir' }).click();
  await expect(editor(page)).toHaveValue(/# Elixir/);
  await step(page, 'elixir-block');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  const versionSelect = page.getByRole('combobox', { name: 'elixir version' });
  await expect(versionSelect).toBeVisible({ timeout: 10000 });
  await expect(versionSelect).toHaveValue('1.20.4');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Hello from Elixir 1\.20\.4/)).toBeVisible({ timeout: 60000 });
  await step(page, 'elixir-output');
});
