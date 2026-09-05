import { test, expect, seedNotes, APP_PATH, type NoteSeed } from './fixtures';

/**
 * Mobile experience: the note sidebar is a top sheet (not an inline `w-72`
 * column), you select a note / edit it full-screen, and a back button returns
 * to selection. Auto-save keeps working. useIsMobile() keys off
 * window.innerWidth < 768, so this spec pins a phone viewport regardless of
 * the project's default viewport.
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

// Phone viewport → useIsMobile() returns true.
test.use({ viewport: { width: 390, height: 844 } });

test('mobile: note list is a top sheet, select → edit full-screen → back', async ({ page }) => {
  const t = new Date();
  await seedNotes(page, [
    makeNote({ title: 'Alpha', content: '# Alpha\n\nAlpha body', updatedAt: t }),
    makeNote({ title: 'Beta', content: 'Beta body', updatedAt: new Date(t.getTime() - 3600000) }),
  ]);
  await page.goto(APP_PATH);

  // On load the sheet is open first (start at selection); no inline .w-72 column.
  await expect(page.getByText('Alpha', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('Search notes...')).toBeVisible();
  await expect(page.locator('div.w-72')).toHaveCount(0);

  // Selecting a note closes the sheet and opens the editor full-screen.
  await page.locator('div.group', { hasText: 'Alpha' }).first().click();
  const editor = page.getByPlaceholder('Start writing... Type / for commands');
  await expect(editor).toHaveValue('# Alpha\n\nAlpha body');
  await expect(page.getByTitle('Back to notes')).toBeVisible();
  await expect(page.locator('div.w-72')).toHaveCount(0);

  // Auto-save persists edits immediately (title derives from the first line).
  await editor.clear();
  await editor.fill('updated on mobile');
  await expect(page.getByRole('heading', { name: 'updated on mobile' })).toBeVisible();

  // Back button returns to selection (top sheet reopens).
  await page.getByTitle('Back to notes').click();
  await expect(page.getByPlaceholder('Search notes...')).toBeVisible();
  await expect(page.getByText('Beta', { exact: true })).toBeVisible();
  await expect(page.locator('div.w-72')).toHaveCount(0);
});
