import { test, expect, step, seedNotes, debugBreak } from './fixtures';

test('loads with empty state', async ({ page }) => {
  await page.goto('/');
  await debugBreak(page, 'empty state loaded — inspect before assertions');
  await expect(page.getByRole('heading', { name: 'No note selected' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Note' })).toBeVisible();
  await expect(page).toHaveScreenshot('empty-state.png');
  await step(page, 'empty-state');
});

test('creates a note and edits title', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No note selected' })).toBeVisible();

  await page.getByRole('button', { name: 'Create Note' }).click();
  const editor = page.getByPlaceholder('Start writing... Type / for commands');
  await expect(editor).toBeVisible();

  // Title is auto-derived from the first line of content (no separate title field).
  await editor.fill('# Playwright Smoke\n\nSome **bold** text');

  // Autosave: wait for the derived title to appear in the sidebar.
  await expect(page.getByText('Playwright Smoke', { exact: true }).first()).toBeVisible();
  await debugBreak(page, 'note created — inspect before assertions');
  await step(page, 'note-created');

  // Reload and confirm the note persisted.
  await page.reload();
  await expect(page.getByText('Playwright Smoke', { exact: true }).first()).toBeVisible();
  await step(page, 'note-persisted');
});

test('toggles between edit and view mode', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Note' }).click();
  const editor = page.getByPlaceholder('Start writing... Type / for commands');
  await expect(editor).toBeVisible();
  await editor.fill('# Hello\n\nSome **bold** text');
  await expect(page.getByText('Hello', { exact: true }).first()).toBeVisible();
  await debugBreak(page, 'note created — inspect before toggling view');

  // Switch to view mode.
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hello', level: 1 })).toBeVisible();
  await expect(page.locator('.prose-notes')).toHaveScreenshot('rendered-note.png');
  await step(page, 'view-mode');

  // Switch back to edit mode.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toBeVisible();
  await step(page, 'edit-mode');
});

test('searches notes', async ({ page }) => {
  const now = new Date();
  await seedNotes(page, [
    {
      title: 'Grocery List',
      content: 'Buy milk and eggs',
      tags: ['life'],
      category: 'General',
      attachments: [],
      createdAt: now,
      updatedAt: now,
      editDates: ['2024-01-01'],
      pinned: false,
      encrypted: null,
    },
    {
      title: 'Meeting Notes',
      content: 'Discuss Q3 roadmap',
      tags: ['work'],
      category: 'General',
      attachments: [],
      createdAt: now,
      updatedAt: now,
      editDates: ['2024-01-01'],
      pinned: false,
      encrypted: null,
    },
    {
      title: 'Ideas',
      content: 'Brainstorm features',
      tags: ['work'],
      category: 'General',
      attachments: [],
      createdAt: now,
      updatedAt: now,
      editDates: ['2024-01-01'],
      pinned: false,
      encrypted: null,
    },
  ]);

  await page.goto('/');
  // Seeded notes should be listed in the sidebar on load.
  await expect(page.getByText('Grocery List', { exact: true })).toBeVisible();
  await expect(page.getByText('Meeting Notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Ideas', { exact: true })).toBeVisible();
  await debugBreak(page, 'seeded notes loaded — inspect before searching');
  await step(page, 'seeded-notes');

  // Search narrows the list.
  const search = page.getByPlaceholder('Search notes...');
  await search.fill('Grocery');
  await expect(page.getByText('Grocery List', { exact: true })).toBeVisible();
  await expect(page.getByText('Meeting Notes', { exact: true })).toBeHidden();
  await expect(page.getByText('Ideas', { exact: true })).toBeHidden();
  await step(page, 'search-results');

  // Clear search.
  await search.fill('');
  await expect(page.getByText('Meeting Notes', { exact: true })).toBeVisible();

  // Filter by tag "work".
  await page.getByRole('button', { name: 'Tags' }).click();
  await page.getByRole('button', { name: 'work', exact: true }).click();
  await expect(page.getByText('Meeting Notes', { exact: true })).toBeVisible();
  await expect(page.getByText('Ideas', { exact: true })).toBeVisible();
  await expect(page.getByText('Grocery List', { exact: true })).toBeHidden();
  await step(page, 'tag-filter');
});
