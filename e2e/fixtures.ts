import { test as base, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A Note-shaped record used to seed IndexedDB before the app loads.
 * Mirrors the `Note` interface in src/lib/db.ts.
 */
export interface NoteSeed {
  id?: number;
  title: string;
  content: string;
  tags: string[];
  category: string;
  attachments: unknown[];
  createdAt: Date;
  updatedAt: Date;
  editDates: string[];
  pinned: boolean;
  encrypted: null;
}

/**
 * Init script that deletes the "NotesApp" IndexedDB database before the app
 * opens it. It only runs on the FIRST navigation of a tab (guarded by
 * sessionStorage) so that a mid-test `page.reload()` does not wipe data the
 * test just created — the DB is still guaranteed fresh at test start because
 * Playwright gives every test a fresh browser context.
 */
const DELETE_DB_SCRIPT = () => {
  if (sessionStorage.getItem('__nh_fresh_db') === '1') return;
  sessionStorage.setItem('__nh_fresh_db', '1');
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('NotesApp');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
};

/**
 * Extended test. The autouse `freshDb` fixture guarantees a brand-new empty
 * IndexedDB for every test by deleting "NotesApp" before the app loads.
 */
export const test = base.extend<{ freshDb: void }>({
  freshDb: [
    async ({ page }, use) => {
      await page.addInitScript(DELETE_DB_SCRIPT);
      await use();
    },
    { auto: true },
  ],
});

/**
 * Seed notes into IndexedDB BEFORE navigation. Opens the raw "NotesApp"
 * database at version 40 (Dexie's `version(4)` maps to IndexedDB version
 * 4 * 10 = 40 — see Dexie's `Math.ceil(idbdb.version / 10)` comparison) and
 * puts the given notes into the "notes" store. Call this before
 * `page.goto('/')`.
 *
 * Note: Playwright serializes init-script args, converting Date objects to
 * ISO strings, so we round-trip them back to Date inside the page.
 */
export async function seedNotes(page: Page, notes: NoteSeed[]): Promise<void> {
  const serializable = notes.map((n) => ({
    ...n,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
    updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : n.updatedAt,
  }));
  await page.addInitScript(
    (seedNotes) => {
      // Reload-safe: only seed once per tab. Mirrors the freshDb guard so a
      // mid-test page.reload() does NOT re-run this script and duplicate the
      // seeded notes. The marker is set before seeding so even a reload that
      // lands mid-seed skips the second pass.
      if (sessionStorage.getItem('__nh_seeded') === '1') return;
      sessionStorage.setItem('__nh_seeded', '1');
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('NotesApp', 40);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('notes')) {
            const s = d.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
            s.createIndex('title', 'title');
            s.createIndex('category', 'category');
            s.createIndex('tags', 'tags', { multiEntry: true });
            s.createIndex('createdAt', 'createdAt');
            s.createIndex('updatedAt', 'updatedAt');
            s.createIndex('pinned', 'pinned');
            s.createIndex('editDates', 'editDates', { multiEntry: true });
          }
          if (!d.objectStoreNames.contains('revisions')) {
            const s = d.createObjectStore('revisions', { keyPath: 'id', autoIncrement: true });
            s.createIndex('noteId', 'noteId');
            s.createIndex('savedAt', 'savedAt');
          }
          if (!d.objectStoreNames.contains('keyPairs')) {
            const s = d.createObjectStore('keyPairs', { keyPath: 'id', autoIncrement: false });
            s.createIndex('fingerprint', 'fingerprint');
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('notes', 'readwrite');
          const store = tx.objectStore('notes');
          for (const note of seedNotes) {
            store.put({
              ...note,
              createdAt: new Date(note.createdAt),
              updatedAt: new Date(note.updatedAt),
            });
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      });
    },
    serializable
  );
}

/**
 * Take a full-page screenshot saved to
 * e2e/artifacts/<test-file-basename>/<test-title>/<name>.png, log the path,
 * and return it. Call after each meaningful UI action in a spec.
 */
export async function step(
  page: Page,
  name: string,
  opts?: { fullPage?: boolean }
): Promise<string> {
  const testInfo = test.info();
  const fileBase = path.basename(testInfo.file, path.extname(testInfo.file));
  const title = testInfo.title.replace(/[^\w-]+/g, '_');
  const dir = path.join(process.cwd(), 'e2e', 'artifacts', fileBase, title);
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: opts?.fullPage ?? true });
  console.log(`[step] ${name}: ${filePath}`);
  return filePath;
}

/**
 * Debug drop-in. When E2E_DEBUG=1 (or "true"), logs a visible banner to the
 * test output and pauses the page so you can interact with the app in the
 * browser, then click "Resume" in the Playwright Inspector. When E2E_DEBUG is
 * unset this is a fast no-op, so the calls can stay in every test permanently.
 *
 * page.pause() is a no-op in headless mode in Playwright 1.58.x (the server-side
 * pause dispatcher is empty), so it never hangs — but the config forces headed
 * mode when E2E_DEBUG is set so the Inspector actually opens.
 */
export async function debugBreak(page: Page, label?: string): Promise<void> {
  if (process.env.E2E_DEBUG !== '1' && process.env.E2E_DEBUG !== 'true') return;
  const heading = label ? `[debugBreak] ${label}` : '[debugBreak]';
  console.log(
    `\n${'='.repeat(72)}\n${heading}\n` +
      `Interact with the app in the browser, then click Resume in the Playwright Inspector.\n` +
      `${'='.repeat(72)}\n`
  );
  await page.pause();
}

export { expect };
