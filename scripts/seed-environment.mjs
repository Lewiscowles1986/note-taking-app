#!/usr/bin/env node
/**
 * seed-environment.mjs — seed a PERSISTENT Chromium profile with the data the
 * e2e suite seeds per spec, then (headed, default) leave the browser open so
 * the app can be explored outside the test runner.
 *
 * Why this exists: the e2e runner cannot show you its data afterwards. Every
 * test gets an ephemeral browser context and the autouse `freshDb` fixture
 * wipes the "NotesApp" IndexedDB per test, so nothing seeded during a run
 * survives to a browser you can open.
 *
 * What it borrows (keep in sync):
 *   - in-page seeding routine ... e2e/fixtures.ts  seedNotes()
 *   - per-spec seed datasets ....... e2e/*.spec.ts makeNote() + seedNotes calls
 *   - SwiftShader launch args ...... playwright.config.ts
 *   - app URL resolution ........... e2e/app-path.ts (E2E_BASE_URL/E2E_BASE_PATH)
 *
 * Usage:
 *   npm run seed:e2e                              # headed, stays open
 *   node scripts/seed-environment.mjs --headless  # seed, verify, exit
 *
 * Flags:
 *   --url URL      App to attach to (default: $E2E_BASE_URL, else
 *                  http://localhost:5173). Must be http(s).
 *   --path PATH    App-root path override (default: $E2E_BASE_PATH, else the
 *                  path of --url; "/" at the origin root) — mirrors app-path.ts.
 *   --profile DIR  Persistent profile dir (default: <repo>/.seed-profile).
 *   --downloads DIR  Where app downloads (Export buttons) are saved. Playwright
 *                  intercepts all downloads and deletes them when the browser
 *                  closes — they never reach $HOME/Downloads — so this script
 *                  saves each one explicitly. Default: <repo>/.seed-downloads;
 *                  pass e.g. ~/Downloads to use the real Downloads folder.
 *   --reset        Delete the profile first (fresh environment).
 *   --headless     Seed + verify + exit instead of staying open.
 *
 * Notes:
 *   - Downloads are saved with an extension: Playwright skips the browser's
 *     MIME-based extension step, so a bare suggested name is sniffed from its
 *     content (zip/json/html/pem/stl) and completed.
 *   - Seeded notes use stable ids (9101+), so re-running overwrites the same
 *     rows instead of duplicating (IndexedDB `put` semantics). Your own notes
 *     (auto-increment ids from 1) are never touched.
 *   - Encrypted-note and legacy-migration seeds are not included: encryption
 *     needs the app's crypto UI flow, and legacy seeds need a DB at an older
 *     schema version, which would conflict with the current-version seeds.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
  process.exit(0);
}
const urlFlag = argValue('--url');
const pathFlag = argValue('--path');
const profileFlag = argValue('--profile');
const headless = argv.includes('--headless');
const reset = argv.includes('--reset');

// ─── App URL (mirrors e2e/app-path.ts) ──────────────────────────────────────
function normalizePath(raw, label) {
  const t = String(raw).trim();
  if (!t.startsWith('/')) throw new Error(`Invalid ${label} "${raw}" — must start with "/"`);
  const stripped = t.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}
const rawUrl = (urlFlag ?? process.env.E2E_BASE_URL ?? 'http://localhost:5173').trim();
if (!/^https?:\/\//.test(rawUrl)) {
  throw new Error(`Invalid app URL "${rawUrl}" — must be an absolute http(s) URL`);
}
const parsedUrl = new URL(rawUrl);
const origin = parsedUrl.origin; // scheme://host[:port] only — the path is handled below
const appPath = pathFlag
  ? normalizePath(pathFlag, '--path')
  : process.env.E2E_BASE_PATH?.trim()
    ? normalizePath(process.env.E2E_BASE_PATH, 'E2E_BASE_PATH')
    : normalizePath(parsedUrl.pathname, 'app URL pathname');
const appUrl = appPath === '/' ? `${origin}/` : origin + appPath;

// ─── Dataset helpers ────────────────────────────────────────────────────────
/** Mirrors makeNote() in the specs (notes.spec.ts et al), plus a stable id. */
function makeNote(id, overrides = {}) {
  const now = new Date();
  return {
    id,
    title: 'Untitled',
    content: '',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    editDates: ['2024-01-01'],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

const HOUR = 3600000;
const iso = (d) => d.toISOString();
const keyOf = (d) => d.toISOString().slice(0, 10); // CalendarView's UTC toDateKey
const dateFromKey = (key) => new Date(`${key}T12:00:00Z`).toISOString();
const now = new Date();
const weekAgo = new Date(now.getTime() - 7 * 86400000);
const monthAgo = new Date(now);
monthAgo.setMonth(monthAgo.getMonth() - 1);

// A minimal valid ASCII STL (a tetrahedron) — borrowed from model3d.spec.ts.
const STL = `solid tetra
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 0 1
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 1 0 0
    vertex 0 1 0
    vertex 0 0 1
  endloop
endfacet
endsolid tetra
`;
const STL_DATA_URL =
  'data:application/octet-stream;base64,' + Buffer.from(STL).toString('base64');

/** One representative note per e2e spec's seed data, ids from 9101. */
const NOTES = [
  // notes.spec.ts — Alpha/Beta/Gamma (Gamma ends the pin test pinned)
  makeNote(9101, { title: 'Alpha', content: '# Alpha\n\nWork note body', category: 'Work' }),
  makeNote(9102, {
    title: 'Beta',
    content: '# Beta\n\nGeneral note body',
    category: 'General',
    updatedAt: iso(new Date(now.getTime() - HOUR)),
  }),
  makeNote(9103, {
    title: 'Gamma',
    content: '# Gamma\n\nGamma body',
    category: 'Ideas',
    updatedAt: iso(new Date(now.getTime() - 2 * HOUR)),
    pinned: true,
  }),
  // notes.spec.ts + tags.spec.ts — tags as the tag tests leave them
  makeNote(9104, { title: 'Tagged', content: '# Tagged\n\nTag me', tags: ['project-x'] }),
  makeNote(9105, {
    title: 'Triple',
    content: '# Triple\n\nThree tags',
    tags: ['one', 'two', 'three'],
  }),
  // calendar.spec.ts — notes on today / a week ago / a month ago
  makeNote(9106, {
    title: 'TodayNote',
    content: '# TodayNote\n\nToday body',
    createdAt: dateFromKey(keyOf(now)),
    updatedAt: dateFromKey(keyOf(now)),
    editDates: [keyOf(now)],
  }),
  makeNote(9107, {
    title: 'WeekAgoNote',
    content: '# WeekAgoNote\n\nWeek ago body',
    createdAt: dateFromKey(keyOf(weekAgo)),
    updatedAt: dateFromKey(keyOf(weekAgo)),
    editDates: [keyOf(weekAgo)],
  }),
  makeNote(9108, {
    title: 'MonthAgoNote',
    content: '# MonthAgoNote\n\nMonth ago body',
    createdAt: dateFromKey(keyOf(monthAgo)),
    updatedAt: dateFromKey(keyOf(monthAgo)),
    editDates: [keyOf(monthAgo)],
  }),
  // editor.spec.ts — callouts, code, lists, GFM
  makeNote(9109, {
    title: 'Callouts',
    content: '# Callouts\n\n> [!NOTE]\n> Note body here\n\n> [!WARNING]\n> Warning body here',
  }),
  makeNote(9110, {
    title: 'Code',
    content: '# Code\n\n```js\nconsole.log("answer:", 6 * 7)\n```',
    hasCodeBlocks: true,
    hasMermaid: false,
  }),
  makeNote(9111, { title: 'List', content: '# List\n\n- first item\n- second item' }),
  makeNote(9112, {
    title: 'GFM',
    content:
      '# GFM\n\n| Name | Value |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n\n- [x] done\n- [ ] todo',
  }),
  makeNote(9113, {
    title: 'Runners',
    content: '# Runners\n\n```js\nconsole.log("runnable")\n```\n\n```python\nprint("hi")\n```',
    hasCodeBlocks: true,
    hasMermaid: false,
  }),
  // features.spec.ts — mermaid, bpmn, geojson
  makeNote(9114, {
    title: 'Multi Mermaid',
    content: `# Multi Mermaid

\`\`\`mermaid
graph TD
    A[Start] --> B[Process]
    B --> C[End]
\`\`\`

\`\`\`mermaid
sequenceDiagram
    participant Alice
    participant Bob
    Alice->>Bob: Hello Bob, how are you?
    Bob-->>Alice: Great!
\`\`\`
`,
    hasMermaid: true,
    hasCodeBlocks: false,
  }),
  makeNote(9115, {
    title: 'Bad Mermaid',
    content: '# Bad Mermaid\n\n```mermaid\ngraph TD; A-->\n```\n\nThis paragraph should still render.',
    hasMermaid: true,
    hasCodeBlocks: false,
  }),
  makeNote(9116, {
    title: 'BPMN',
    content: `# BPMN

\`\`\`bpmn
<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="p1" isExecutable="true">
    <startEvent id="start" />
    <endEvent id="end" />
  </process>
</definitions>
\`\`\`
`,
    hasCodeBlocks: true,
    hasMermaid: false,
  }),
  makeNote(9117, {
    title: 'Geo Map',
    content: `# Geo Map

\`\`\`geojson
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "Sydney" },
      "geometry": { "type": "Point", "coordinates": [151.2093, -33.8688] }
    },
    {
      "type": "Feature",
      "properties": { "name": "London" },
      "geometry": { "type": "Point", "coordinates": [-0.1276, 51.5074] }
    },
    {
      "type": "Feature",
      "properties": { "name": "New York" },
      "geometry": { "type": "Point", "coordinates": [-74.006, 40.7128] }
    }
  ]
}
\`\`\`
`,
    hasGeoJson: true,
    hasCodeBlocks: false,
  }),
  // model3d.spec.ts — 3D model block (tetrahedron STL as a data URL)
  makeNote(9118, {
    title: 'Default VP',
    content: `# Default VP

\`\`\`3dmodel
---
camera: [0, 0, 20]
---
${STL_DATA_URL}
\`\`\`
`,
    hasModel3D: true,
    hasCodeBlocks: false,
  }),
];

// ─── In-page seeding (mirrors e2e/fixtures.ts seedNotes — keep in sync) ─────
function seedInitScript(notes) {
  return (seedNotes) => {
    // Same sessionStorage guard as the fixtures: a reload never re-seeds.
    if (sessionStorage.getItem('__nh_seeded') === '1') return;
    sessionStorage.setItem('__nh_seeded', '1');
    return new Promise((resolve, reject) => {
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
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────
const profileDir = path.resolve(repoRoot, profileFlag ?? '.seed-profile');
if (reset) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log(`[seed] reset profile: ${profileDir}`);
}
fs.mkdirSync(profileDir, { recursive: true });

// Downloads dir; expand a leading ~/ so `--downloads ~/Downloads` works.
const downloadsDir = path.resolve(
  repoRoot,
  (argValue('--downloads') ?? '.seed-downloads').replace(/^~(?=\/|$)/, os.homedir()),
);
fs.mkdirSync(downloadsDir, { recursive: true });

console.log(`[seed] app:  ${appUrl}`);
console.log(`[seed] profile: ${profileDir}`);
console.log(`[seed] downloads: ${downloadsDir}`);

// SwiftShader args copied from playwright.config.ts so WebGL (three.js 3D
// models) works in this headless-capable Chromium too.
const context = await chromium.launchPersistentContext(profileDir, {
  headless,
  viewport: { width: 1440, height: 900 },
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.addInitScript(seedInitScript(NOTES), NOTES);

// Playwright intercepts every download into an OS temp dir and DELETES it when
// the context closes — it never reaches $HOME/Downloads. Save each download
// explicitly so it survives.
//
// Extension gap vs a real browser: Playwright's suggestedFilename() is the raw
// name the page suggested. Regular Chrome/Firefox run the download through
// Chromium's naming pipeline, which appends an extension derived from the MIME
// type when the name has none — Playwright's interception skips that. So a
// download a real browser saves as "name.stl" can land here as bare "name".
// Replicate the browser behavior: save, sniff magic bytes, add the extension.
const EXT_BY_MAGIC = [
  ['PK\x03\x04', 'zip'],
  ['-----BEGIN', 'pem'],
  ['solid ', 'stl'],
];
function detectMissingExtension(filePath) {
  const head = fs.readFileSync(filePath).subarray(0, 64);
  const latin = head.toString('latin1');
  for (const [magic, ext] of EXT_BY_MAGIC) {
    if (latin.startsWith(magic)) return ext;
  }
  const text = head.toString('utf8');
  if (/^\s*[[{]/.test(text)) return 'json';
  if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) return 'html';
  return undefined;
}
context.on('download', (download) => {
  const suggested = download.suggestedFilename();
  const bare = path.extname(suggested) === '';
  const target = path.join(downloadsDir, suggested);
  void download
    .saveAs(target)
    .then(() => {
      if (bare) {
        const ext = detectMissingExtension(target);
        if (ext) {
          const renamed = `${target}.${ext}`;
          fs.renameSync(target, renamed);
          console.log(`[seed] download saved: ${renamed} (extension added from content)`);
          return;
        }
      }
      console.log(`[seed] download saved: ${target}`);
    })
    .catch((err) => console.error(`[seed] download failed: ${err.message}`));
});

await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
// Wait until the app has opened the DB and rendered sidebar note items.
const appRendered = await page
  .locator('div.group')
  .first()
  .waitFor({ timeout: 30000 })
  .then(() => true)
  .catch(() => false);
await page.waitForTimeout(1000); // let async renders (mermaid/3d) settle

const rendered = appRendered ? await page.locator('div.group').count() : 0;
console.log(`[seed] app rendered ${rendered} note item(s) in the sidebar`);

const count = await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const rq = indexedDB.open('NotesApp', 40);
      rq.onsuccess = () => {
        const db = rq.result;
        const tx = db.transaction('notes', 'readonly');
        const rqCount = tx.objectStore('notes').count();
        rqCount.onsuccess = () => {
          db.close();
          resolve(rqCount.result);
        };
        rqCount.onerror = () => {
          db.close();
          reject(rqCount.error);
        };
      };
      rq.onerror = () => reject(rq.error);
    }),
);
console.log(`[seed] done — ${count} notes in the profile (seeded ids 9101+, stable on re-run)`);

if (rendered === 0) {
  console.error(
    `[seed] ERROR: the app did not render any seeded notes at ${appUrl} — ` +
      'check the URL (a 404 page still seeds the origin-scoped DB).',
  );
  await context.close();
  process.exit(1);
}

if (headless) {
  await context.close();
  console.log('[seed] headless run complete, exiting.');
  process.exit(0);
}

console.log('[seed] browser left open — explore the app, then Ctrl+C to quit.');
process.on('SIGINT', () => {
  void context.close().then(() => process.exit(0));
});
await new Promise(() => {});