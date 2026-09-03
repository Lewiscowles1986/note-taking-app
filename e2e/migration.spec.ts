import { test, expect, step, seedLegacyNotes, debugBreak, type LegacyNoteSeed } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Round I migration suite. Proves that OLD databases (pre-migration schema
 * versions) migrate cleanly when the app's Dexie upgrade path runs on load,
 * and that migrated notes remain fully EDITABLE with correct revision-history
 * and editDates behavior.
 *
 * Seeding is separate from migration: we open raw IndexedDB at an OLDER schema
 * version (10 = Dexie v1, 20 = v2, 30 = v3) with old-shape notes, then let the
 * app open the DB and Dexie upgrade it to version 40 automatically.
 */

/** Build a Date at UTC noon for a YYYY-MM-DD key (matches db.ts toDateKey). */
function dateFromKey(key: string): Date {
  return new Date(key + 'T12:00:00Z');
}

const editor = (page: Page) => page.getByPlaceholder('Start writing... Type / for commands');
const grid = (page: Page) => page.locator('div.grid.grid-cols-7.flex-1 > div');

/** Read the raw DB version, store names, and a plain summary of every note. */
function readDbState(page: Page) {
  return page.evaluate(() => {
    return new Promise<{
      version: number;
      stores: string[];
      notes: {
        title: string;
        editDates: string[];
        hasCodeBlocks: boolean;
        hasMermaid: boolean;
        createdAtKey: string | null;
        updatedAtKey: string | null;
      }[];
    }>((resolve, reject) => {
      const req = indexedDB.open('NotesApp');
      req.onsuccess = () => {
        const db = req.result;
        const version = db.version;
        const stores = Array.from(db.objectStoreNames);
        const tx = db.transaction('notes', 'readonly');
        const getAll = tx.objectStore('notes').getAll();
        getAll.onsuccess = () => {
          const notes = getAll.result.map((n: any) => ({
            title: n.title,
            editDates: n.editDates || [],
            hasCodeBlocks: !!n.hasCodeBlocks,
            hasMermaid: !!n.hasMermaid,
            createdAtKey: n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : null,
            updatedAtKey: n.updatedAt ? new Date(n.updatedAt).toISOString().slice(0, 10) : null,
          }));
          db.close();
          resolve({ version, stores, notes });
        };
        getAll.onerror = () => {
          db.close();
          reject(getAll.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/** Read all revision rows for a noteId, ordered by savedAt ascending. */
function readRevisions(page: Page, noteId: number) {
  return page.evaluate((id) => {
    return new Promise<
      { noteId: number; title: string; content: string; savedAt: string }[]
    >((resolve, reject) => {
      const req = indexedDB.open('NotesApp');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('revisions', 'readonly');
        const idx = tx.objectStore('revisions').index('noteId');
        const getReq = idx.getAll(id);
        getReq.onsuccess = () => {
          const rows = getReq.result
            .map((r: any) => ({
              noteId: r.noteId,
              title: r.title,
              content: r.content,
              savedAt: new Date(r.savedAt).toISOString(),
            }))
            .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
          db.close();
          resolve(rows);
        };
        getReq.onerror = () => {
          db.close();
          reject(getReq.error);
        };
      };
      req.onerror = () => reject(req.error);
    });
  }, noteId);
}

/** Read a note's content by title index (mirrors editor.spec helper). */
function readNoteContent(page: Page, title: string): Promise<string | null> {
  return page.evaluate((t) => {
    return new Promise<string | null>((resolve, reject) => {
      const req = indexedDB.open('NotesApp');
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

/** Read a note's editDates array by title index. */
function readNoteEditDates(page: Page, title: string): Promise<string[]> {
  return page.evaluate((t) => {
    return new Promise<string[]>((resolve, reject) => {
      const req = indexedDB.open('NotesApp');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('notes', 'readonly');
        const store = tx.objectStore('notes');
        const idx = store.index('title');
        const getReq = idx.get(t);
        getReq.onsuccess = () => {
          db.close();
          resolve(getReq.result ? getReq.result.editDates || [] : []);
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

test('migrates a v1 database to the current schema', async ({ page }) => {
  const todayKey = new Date().toISOString().slice(0, 10);
  const threeDaysAgoKey = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgoKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const notes: LegacyNoteSeed[] = [
    {
      id: 1,
      title: 'Mermaid Note',
      content: '# Mermaid Note\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```',
      tags: ['diagram'],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
    {
      id: 2,
      title: 'Code Note',
      content: '# Code Note\n\n```js\nconsole.log("hi")\n```',
      tags: ['dev'],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(threeDaysAgoKey),
      updatedAt: dateFromKey(threeDaysAgoKey),
      pinned: false,
    },
    {
      id: 3,
      title: 'Plain Note',
      content: '# Plain Note\n\nJust some text',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(thirtyDaysAgoKey),
      updatedAt: dateFromKey(thirtyDaysAgoKey),
      pinned: false,
    },
  ];

  await seedLegacyNotes(page, 10, notes);
  await page.goto('/');

  // All 3 migrated notes are listed in the sidebar.
  await expect(page.getByText('Mermaid Note', { exact: true })).toBeVisible();
  await expect(page.getByText('Code Note', { exact: true })).toBeVisible();
  await expect(page.getByText('Plain Note', { exact: true })).toBeVisible();
  await debugBreak(page, 'v1 migrated — inspect before DB assertions');
  await step(page, 'migrated-list');

  // The app's Dexie upgrade path must have bumped the raw DB to version 40.
  await expect.poll(async () => (await readDbState(page)).version).toBe(40);
  const state = await readDbState(page);
  expect(state.stores).toContain('notes');
  expect(state.stores).toContain('revisions');
  expect(state.stores).toContain('keyPairs');

  // editDates backfilled from createdAt/updatedAt; feature flags computed.
  const mermaid = state.notes.find((n) => n.title === 'Mermaid Note');
  expect(mermaid).toBeTruthy();
  expect(mermaid!.editDates).toContain(todayKey);
  expect(mermaid!.hasMermaid).toBe(true);
  expect(mermaid!.hasCodeBlocks).toBe(false);

  const code = state.notes.find((n) => n.title === 'Code Note');
  expect(code).toBeTruthy();
  expect(code!.editDates).toContain(threeDaysAgoKey);
  expect(code!.hasCodeBlocks).toBe(true);
  expect(code!.hasMermaid).toBe(false);

  const plain = state.notes.find((n) => n.title === 'Plain Note');
  expect(plain).toBeTruthy();
  expect(plain!.editDates).toContain(thirtyDaysAgoKey);
  await step(page, 'migrated-db');
});

test('edits a note that was migrated from v1', async ({ page }) => {
  const todayKey = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgoKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  await seedLegacyNotes(page, 10, [
    {
      id: 1,
      title: 'Old Note',
      content: '# Old Note\n\nOriginal body',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(thirtyDaysAgoKey),
      updatedAt: dateFromKey(thirtyDaysAgoKey),
      pinned: false,
    },
    {
      id: 2,
      title: 'Newer Note',
      content: '# Newer Note\n\nBody',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
  ]);
  await page.goto('/');
  await expect(page.getByText('Old Note', { exact: true })).toBeVisible();
  await debugBreak(page, 'v1 migrated — inspect before editing');

  // Open the oldest note and edit it: change the heading + append a line.
  await page.locator('div.group', { hasText: 'Old Note' }).click();
  await expect(editor(page)).toHaveValue(/# Old Note\n\nOriginal body/);
  await editor(page).fill('# Old Note Updated\n\nOriginal body\n\nAppended line');
  // Per-keystroke autosave: poll IDB for the new content.
  await expect.poll(() => readNoteContent(page, 'Old Note Updated')).toContain('Appended line');
  await step(page, 'edit-migrated');

  // Reload and confirm the edits persisted.
  await page.reload();
  await page.locator('div.group', { hasText: 'Old Note Updated' }).click();
  await expect(editor(page)).toHaveValue(/# Old Note Updated\n\nOriginal body\n\nAppended line/);
  await step(page, 'after-reload');
});

test('creates a revision snapshot when editing a migrated note', async ({ page }) => {
  const thirtyDaysAgoKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  await seedLegacyNotes(page, 10, [
    {
      id: 1,
      title: 'Migrated Note',
      content: '# Migrated Note\n\nOriginal body',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(thirtyDaysAgoKey),
      updatedAt: dateFromKey(thirtyDaysAgoKey),
      pinned: false,
    },
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Migrated Note' }).click();
  await expect(editor(page)).toHaveValue(/# Migrated Note\n\nOriginal body/);
  await debugBreak(page, 'migrated note open — inspect before editing');

  // First edit -> one revision snapshot with the pre-edit title/content.
  await editor(page).fill('# Migrated Note\n\nOriginal body\n\nFirst edit');
  await expect.poll(async () => (await readRevisions(page, 1)).length).toBe(1);
  let revs = await readRevisions(page, 1);
  expect(revs[0].title).toBe('Migrated Note');
  expect(revs[0].content).toContain('Original body');
  await step(page, 'revision-1');

  // Second edit -> two revision rows for the same noteId.
  await editor(page).fill('# Migrated Note\n\nOriginal body\n\nFirst edit\n\nSecond edit');
  await expect.poll(async () => (await readRevisions(page, 1)).length).toBe(2);
  revs = await readRevisions(page, 1);
  expect(revs[0].content).toContain('Original body');
  expect(revs[1].content).toContain('First edit');
  await step(page, 'revision-2');
});

test('updates editDates when editing a migrated note', async ({ page }) => {
  const todayKey = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgoKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  await seedLegacyNotes(page, 10, [
    {
      id: 1,
      title: 'Old Date Note',
      content: '# Old Date Note\n\nBody',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(thirtyDaysAgoKey),
      updatedAt: dateFromKey(thirtyDaysAgoKey),
      pinned: false,
    },
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'Old Date Note' }).click();
  await expect(editor(page)).toHaveValue(/# Old Date Note\n\nBody/);
  await debugBreak(page, 'old-date note open — inspect before editing');

  // Edit today: editDates must now include today AND retain the old key.
  await editor(page).fill('# Old Date Note\n\nBody\n\nEdited today');
  await expect.poll(() => readNoteEditDates(page, 'Old Date Note')).toContain(todayKey);
  const dates = await readNoteEditDates(page, 'Old Date Note');
  expect(dates).toContain(thirtyDaysAgoKey);
  expect(dates).toContain(todayKey);
  await step(page, 'editdates-updated');

  // Calendar view: navigate back to the old month and confirm the note shows
  // on the old date cell.
  await page.getByTitle('Calendar view').click();
  await expect(page.getByText('Calendar', { exact: true })).toBeVisible();
  for (let i = 0; i < 3; i++) {
    if ((await grid(page).filter({ hasText: 'Old Date Note' }).count()) > 0) break;
    await page.locator('button:has(svg.lucide-chevron-left)').click();
  }
  await expect(grid(page).filter({ hasText: 'Old Date Note' })).toBeVisible();
  await step(page, 'calendar-shows-old-date');
});

test('migrates a v2 database preserving feature flags', async ({ page }) => {
  const todayKey = new Date().toISOString().slice(0, 10);

  await seedLegacyNotes(page, 20, [
    {
      id: 1,
      title: 'V2 Mermaid',
      content: '# V2 Mermaid\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
      hasMermaid: true,
      hasCodeBlocks: false,
    },
  ]);
  await page.goto('/');
  await page.locator('div.group', { hasText: 'V2 Mermaid' }).click();
  await expect(editor(page)).toHaveValue(/# V2 Mermaid/);
  await debugBreak(page, 'v2 migrated — inspect before view render');

  // The v2 hasMermaid flag must survive migration so the mermaid renderer loads.
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('.prose-notes svg')).toBeVisible({ timeout: 15000 });
  await step(page, 'v2-migrated-render');
});

test('migrates a v3 database and keeps notes editable', async ({ page }) => {
  const thirtyDaysAgoKey = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  await seedLegacyNotes(
    page,
    30,
    [
      {
        id: 1,
        title: 'V3 Note',
        content: '# V3 Note\n\nCurrent version',
        tags: [],
        category: 'General',
        attachments: [],
        createdAt: dateFromKey(thirtyDaysAgoKey),
        updatedAt: dateFromKey(thirtyDaysAgoKey),
        pinned: false,
        editDates: [thirtyDaysAgoKey],
      },
    ],
    [
      {
        noteId: 1,
        title: 'V3 Note',
        content: '# V3 Note\n\nOlder version',
        tags: [],
        category: 'General',
        savedAt: dateFromKey(thirtyDaysAgoKey),
      },
    ]
  );
  await page.goto('/');
  await page.locator('div.group', { hasText: 'V3 Note' }).click();
  await expect(editor(page)).toHaveValue(/# V3 Note\n\nCurrent version/);
  await debugBreak(page, 'v3 migrated — inspect before editing');

  // Edit the note: revision count grows by one, original revision intact.
  await editor(page).fill('# V3 Note\n\nCurrent version\n\nEdited after migration');
  await expect.poll(async () => (await readRevisions(page, 1)).length).toBe(2);
  const revs = await readRevisions(page, 1);
  expect(revs[0].content).toContain('Older version');
  expect(revs[1].content).toContain('Current version');
  await step(page, 'v3-edited');
});

test('seeded legacy notes appear correctly in search and tags', async ({ page }) => {
  const todayKey = new Date().toISOString().slice(0, 10);

  await seedLegacyNotes(page, 10, [
    {
      id: 1,
      title: 'Legacy Grocery',
      content: 'Buy milk and eggs',
      tags: ['life'],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
    {
      id: 2,
      title: 'Legacy Work',
      content: 'Discuss Q3 roadmap',
      tags: ['work'],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
  ]);
  await page.goto('/');
  await expect(page.getByText('Legacy Grocery', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy Work', { exact: true })).toBeVisible();
  await debugBreak(page, 'v1 migrated — inspect before search');

  // Search narrows to the migrated note.
  const search = page.getByPlaceholder('Search notes...');
  await search.fill('Grocery');
  await expect(page.getByText('Legacy Grocery', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy Work', { exact: true })).toBeHidden();
  await step(page, 'legacy-search');

  // Clear search, then filter by tag via the Tags facet.
  await search.fill('');
  await expect(page.getByText('Legacy Work', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tags' }).click();
  await page.getByRole('button', { name: 'work', exact: true }).click();
  await expect(page.getByText('Legacy Work', { exact: true })).toBeVisible();
  await expect(page.getByText('Legacy Grocery', { exact: true })).toBeHidden();
  await step(page, 'legacy-tag-filter');
});

test('handles a v1 database with edge-case rows', async ({ page }) => {
  const todayKey = new Date().toISOString().slice(0, 10);

  await seedLegacyNotes(page, 10, [
    {
      id: 1,
      title: 'Empty',
      content: '',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
    {
      id: 2,
      title: 'Long',
      content: 'x'.repeat(2000),
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
    {
      id: 3,
      title: '🚀 Launch 🚀',
      content: '# 🚀 Launch 🚀\n\nBlast off',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
    {
      id: 4,
      title: 'NoCat',
      content: '# NoCat\n\nBody',
      tags: [],
      category: '',
      attachments: [],
      createdAt: dateFromKey(todayKey),
      updatedAt: dateFromKey(todayKey),
      pinned: false,
    },
  ]);
  await page.goto('/');

  // Migration must not crash; all 4 edge-case notes are listed.
  await expect(page.getByText('Empty', { exact: true })).toBeVisible();
  await expect(page.getByText('Long', { exact: true })).toBeVisible();
  await expect(page.getByText('🚀 Launch 🚀', { exact: true })).toBeVisible();
  await expect(page.getByText('NoCat', { exact: true })).toBeVisible();
  await debugBreak(page, 'edge-case v1 migrated — inspect before opening each');
  await step(page, 'edge-migrated');

  // Open each and confirm the editor loads without crashing.
  await page.locator('div.group', { hasText: 'Empty' }).click();
  await expect(editor(page)).toHaveValue('');

  await page.locator('div.group', { hasText: 'Long' }).click();
  await expect(editor(page)).toHaveValue('x'.repeat(2000));

  await page.locator('div.group', { hasText: '🚀 Launch 🚀' }).click();
  await expect(editor(page)).toHaveValue(/# 🚀 Launch 🚀\n\nBlast off/);

  await page.locator('div.group', { hasText: 'NoCat' }).click();
  await expect(editor(page)).toHaveValue(/# NoCat\n\nBody/);
});
