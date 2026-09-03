import { test, expect, step, seedNotes, debugBreak, type NoteSeed } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Round C writing/rendering suite. Covers the slash-command menu, markdown
 * list auto-continuation, callout rendering, JS code-block execution, mermaid
 * diagram rendering, autosave persistence, and GFM tables/task lists.
 *
 * Uses the shared freshDb/seedNotes/step helpers from fixtures.ts.
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

/**
 * Read a note's content straight from IndexedDB (by title index). Used to
 * assert that an autosave actually reached the database without relying on a
 * UI save indicator.
 */
function readNoteContent(page: Page, title: string): Promise<string | null> {
  return page.evaluate((t) => {
    return new Promise<string | null>((resolve, reject) => {
      const req = indexedDB.open('NotesApp', 40);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('notes', 'readonly');
        const store = tx.objectStore('notes');
        const idx = store.index('title');
        const getReq = idx.get(t);
        getReq.onsuccess = () => {
          db.close();
          resolve(getReq.result ? getReq.result.content : null);
        };
        getReq.onerror = () => {
          db.close();
          reject(getReq.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
  }, title);
}

test('slash command menu opens and inserts a code block', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'Slash', content: '# Slash\n\n' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Slash' }).click();
  await expect(editor(page)).toHaveValue(/# Slash\n\n/);
  await debugBreak(page, 'note open — inspect before slash command');

  // Position the cursor on an empty line, then type "/" to open the menu.
  await editor(page).click();
  await editor(page).press('End');
  await editor(page).press('Enter');
  await editor(page).type('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await step(page, 'slash-menu-open');

  // Select the "Code Block" item -> inserts a fenced code block.
  await page.locator('.slash-menu-item', { hasText: 'Code Block' }).click();
  await expect(editor(page)).toHaveValue(/```/);
  // Selecting a command closes the menu automatically.
  await expect(page.locator('.slash-menu')).toBeHidden();
  await step(page, 'slash-inserted');
});

test('auto-continues markdown lists', async ({ page }) => {
  await seedNotes(page, [makeNote({ title: 'List', content: '# List\n\n' })]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'List' }).click();
  await expect(editor(page)).toHaveValue(/# List\n\n/);
  await debugBreak(page, 'note open — inspect before list typing');

  // Type a bullet item and press Enter at the end of the line.
  await editor(page).fill('- first item');
  await editor(page).press('Enter');
  // The app auto-prefixes the new line with "- " (see NoteEditor handleKeyDown).
  await expect(editor(page)).toHaveValue(/- first item\n- /);
  await step(page, 'list-typing');
});

test('renders callouts in view mode', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Callouts',
      content: '# Callouts\n\n> [!NOTE]\n> Note body here\n\n> [!WARNING]\n> Warning body here',
    }),
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Callouts' }).click();
  await expect(editor(page)).toHaveValue(/# Callouts/);
  await debugBreak(page, 'note open — inspect before view mode');
  await step(page, 'callouts-edit');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  // Callouts render as .callout-<colorKey> blocks (see src/lib/callouts.ts).
  await expect(page.locator('.callout-note')).toBeVisible();
  await expect(page.locator('.callout-note')).toContainText('Note body here');
  await expect(page.locator('.callout-warning')).toBeVisible();
  await expect(page.locator('.callout-warning')).toContainText('Warning body here');
  await step(page, 'callouts-view');
});

test('runs a JavaScript code block and shows output', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Code',
      content: '# Code\n\n```js\nconsole.log("answer:", 6 * 7)\n```',
      hasCodeBlocks: true,
      hasMermaid: false,
    }),
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Code' }).click();
  await expect(editor(page)).toHaveValue(/# Code/);
  await debugBreak(page, 'note open — inspect before running code');
  await step(page, 'code-block');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  // The CodeBlock header exposes a "Run" control for languages with a runner.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // jsRunner captures console.log as "[log]: answer: 42".
  await expect(page.getByText('answer: 42')).toBeVisible({ timeout: 10000 });
  await step(page, 'code-output');
});

test('renders a mermaid diagram', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'Mermaid',
      content: '# Mermaid\n\n```mermaid\ngraph TD\n    A[Start] --> B[End]\n```',
      hasMermaid: true,
      hasCodeBlocks: false,
    }),
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Mermaid' }).click();
  await expect(editor(page)).toHaveValue(/# Mermaid/);
  await debugBreak(page, 'note open — inspect before mermaid render');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  // Mermaid renders asynchronously into an <svg> inside the viewer.
  await expect(page.locator('.prose-notes svg')).toBeVisible({ timeout: 15000 });
  await step(page, 'mermaid-rendered');
});

test('autosaves edits and persists across reload', async ({ page }) => {
  // NOTE: we create the note via the UI rather than seedNotes. The seed init
  // script re-runs on every navigation (it is not sessionStorage-guarded like
  // the freshDb delete script), so a seeded note would be duplicated on
  // page.reload(). Creating via the UI keeps the DB single-copy across reload.
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Note' }).click();
  await editor(page).fill('# Autosave Target\n\nInitial');
  await expect(page.getByText('Autosave Target', { exact: true }).first()).toBeVisible();
  await debugBreak(page, 'note created — inspect before editing');

  // Append a paragraph. NoteEditor saves on every change (no debounce), so the
  // DB write happens immediately; poll IndexedDB to confirm it landed.
  await editor(page).fill('# Autosave Target\n\nInitial\n\nAppended line');
  await expect.poll(() => readNoteContent(page, 'Autosave Target')).toContain('Appended line');
  await step(page, 'edited');

  // Reload, reopen the note, and confirm the appended line persisted.
  await page.reload();
  await page.locator('div.group', { hasText: 'Autosave Target' }).click();
  await expect(editor(page)).toHaveValue(/Appended line/);
  await step(page, 'after-reload');
});

test('renders GFM tables and task lists', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'GFM',
      content: '# GFM\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n\n- [x] done\n- [ ] todo',
    }),
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'GFM' }).click();
  await expect(editor(page)).toHaveValue(/# GFM/);
  await debugBreak(page, 'note open — inspect before GFM render');

  await page.getByRole('button', { name: 'View', exact: true }).click();
  // remark-gfm renders the table and task-list checkboxes.
  await expect(page.locator('.prose-notes table')).toBeVisible();
  await expect(page.locator('.prose-notes table')).toContainText('Name');
  await expect(page.locator('.prose-notes input[type="checkbox"]')).toHaveCount(2);
  await step(page, 'gfm-view');
});
