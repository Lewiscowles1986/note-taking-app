import { test, expect, seedNotes, step, type NoteSeed, APP_PATH } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Python wasm runner acceptance: seed a note with a python block, switch to
 * View, run it, and assert real output from the vendored CPython build.
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

test('runs a Python code block via wasm', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Python',
      content: '# Python\n\n```python\nimport sys\nprint("Hello from Python", sys.version.split()[0])\n```',
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'Python' }).click();
  await expect(editor(page)).toHaveValue(/# Python/);
  await step(page, 'python-block');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  const versionSelect = page.getByRole('combobox', { name: 'python version' });
  await expect(versionSelect).toBeVisible({ timeout: 10000 });
  await expect(versionSelect).toHaveValue('3.14.7');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Hello from Python 3\.14\.7/)).toBeVisible({ timeout: 60000 });
  await step(page, 'python-output');
});
