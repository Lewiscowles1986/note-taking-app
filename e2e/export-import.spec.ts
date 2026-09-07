import { test, expect, step, seedNotes, debugBreak, type NoteSeed, APP_PATH } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Round D export/import suite. Covers the single-note HTML export, the full
 * database backup (JSON), and importing notes from a file via the sidebar's
 * hidden file input. Reads the real NoteSidebar + export.ts/import.ts behavior.
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

const downloadsDir = path.join(process.cwd(), 'e2e', 'artifacts', 'downloads');

test('exports a single note as a download', async ({ page }) => {
  await seedNotes(page, [
    makeNote({ title: 'ExportMe', content: '# ExportMe\n\nExport body text' }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'ExportMe' }).click();
  await expect(page.getByRole('heading', { name: 'ExportMe', level: 2 })).toBeVisible();
  await debugBreak(page, 'note open — inspect before export');

  // Open the export dropdown and trigger the single-note HTML export.
  await page.getByTitle('Export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current as HTML' }).click();
  const download = await downloadPromise;

  const suggested = download.suggestedFilename();
  expect(suggested).toMatch(/^ExportMe\.html$/);

  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, suggested);
  await download.saveAs(savePath);
  const html = fs.readFileSync(savePath, 'utf8');
  // The HTML export embeds the title and the markdown-derived body.
  expect(html).toContain('ExportMe');
  expect(html).toContain('Export body text');
  await step(page, 'export-download');
});

test('exports the full database backup', async ({ page }) => {
  await seedNotes(page, [
    makeNote({ title: 'BackupMe', content: '# BackupMe\n\nBackup body' }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('BackupMe', { exact: true })).toBeVisible();
  await debugBreak(page, 'note seeded — inspect before backup export');

  await page.getByTitle('Export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full database backup' }).click();
  const download = await downloadPromise;

  const suggested = download.suggestedFilename();
  expect(suggested).toMatch(/^notesapp-backup-\d{4}-\d{2}-\d{2}\.json$/);

  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, suggested);
  await download.saveAs(savePath);
  const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  expect(data.tables).toBeDefined();
  expect(Array.isArray(data.tables.notes)).toBe(true);
  expect(data.tables.notes.some((n: { title: string }) => n.title === 'BackupMe')).toBe(true);
  await step(page, 'db-export');
});

test('exports all notes as a ZIP', async ({ page }) => {
  await seedNotes(page, [
    makeNote({ title: 'ZipOne', content: '# ZipOne\n\nFirst zip body' }),
    makeNote({ title: 'ZipTwo', content: '# ZipTwo\n\nSecond zip body' }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('ZipOne', { exact: true })).toBeVisible();
  await expect(page.getByText('ZipTwo', { exact: true })).toBeVisible();
  await debugBreak(page, 'notes seeded — inspect before ZIP export');

  // Open the export dropdown and trigger the "Export all as ZIP" action.
  await page.getByTitle('Export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all as ZIP' }).click();
  const download = await downloadPromise;

  const suggested = download.suggestedFilename();
  expect(suggested).toBe('notes-export.zip');

  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, suggested);
  await download.saveAs(savePath);

  // 1) Magic bytes: a valid ZIP starts with the local-file-header signature "PK".
  const head = fs.readFileSync(savePath).subarray(0, 2).toString('latin1');
  expect(head).toBe('PK');

  // 2) Integrity: `unzip -t` verifies the archive opens and every entry's CRC
  //    matches. Throws (non-zero exit) if the archive is corrupt.
  execFileSync('unzip', ['-t', savePath], { stdio: 'pipe' });

  // 3) Contents: each note is a slug folder holding its rendered HTML + source.
  const listing = execFileSync('unzip', ['-l', savePath], { encoding: 'utf8' });
  expect(listing).toContain('notes/zipone/zipone.html');
  expect(listing).toContain('notes/zipone/README.md');
  expect(listing).toContain('notes/ziptwo/ziptwo.html');
  expect(listing).toContain('notes/ziptwo/README.md');
  await step(page, 'zip-export');
});

test('ZIP keeps raw markdown (edit view) and rich HTML (view) separate', async ({ page }) => {
  const diagram = ['graph TD', '  A[Start] --> B[End]'].join('\n');
  await seedNotes(page, [
    makeNote({
      title: 'ZipMermaid',
      content: ['# ZipMermaid', '', '```mermaid', 'graph TD', '  A[Start] --> B[End]', '```', ''].join('\n'),
    }),
  ]);
  await page.goto(APP_PATH);
  await expect(page.getByText('ZipMermaid', { exact: true })).toBeVisible();
  await debugBreak(page, 'zip mermaid note seeded');

  await page.getByTitle('Export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all as ZIP' }).click();
  const download = await downloadPromise;

  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, download.suggestedFilename());
  await download.saveAs(savePath);

  // Markdown is the edit-view source: the mermaid code fence is preserved verbatim.
  const md = execFileSync('unzip', ['-p', savePath, 'notes/zipmermaid/README.md'], { encoding: 'utf8' });
  expect(md).toContain('```mermaid');
  expect(md).toContain(diagram);

  // HTML is the rendered view: the diagram is embedded as SVG, not a code fence.
  const html = execFileSync('unzip', ['-p', savePath, 'notes/zipmermaid/zipmermaid.html'], { encoding: 'utf8' });
  expect(html).toContain('<svg');
  expect(html).not.toContain('```mermaid');
  await step(page, 'zip-markdown-vs-html');
});

test('HTML export includes rendered mermaid graphics', async ({ page }) => {
  await seedNotes(page, [
    makeNote({
      title: 'DiagramNote',
      content: [
        '# DiagramNote',
        '',
        '```mermaid',
        'graph TD',
        '  A[Start] --> B[End]',
        '```',
      ].join('\n'),
    }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'DiagramNote' }).click();
  await expect(page.getByRole('heading', { name: 'DiagramNote', level: 2 })).toBeVisible();

  // Open the export dropdown and trigger the single-note HTML export.
  await page.getByTitle('Export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current as HTML' }).click();
  const download = await downloadPromise;

  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, download.suggestedFilename());
  await download.saveAs(savePath);
  const html = fs.readFileSync(savePath, 'utf8');

  // The note view (not the raw markdown) is exported, so the mermaid block is
  // present as rendered SVG rather than a ```mermaid code fence.
  expect(html).toContain('<svg');
  expect(html).toContain('Start');
  expect(html).not.toContain('```mermaid');
  await step(page, 'rich-html-export');
});

test('HTML export renders the 3D model', async ({ page }) => {
  // A minimal valid ASCII STL (tetrahedron) embedded as a data URL — matches
  // the fixtures used by model3d.spec.ts.
  const STL = [
    'solid tetra',
    'facet normal 0 0 1',
    '  outer loop',
    '    vertex 0 0 0',
    '    vertex 1 0 0',
    '    vertex 0 1 0',
    '  endloop',
    'endfacet',
    'facet normal 0 0 1',
    '  outer loop',
    '    vertex 0 0 0',
    '    vertex 0 0 1',
    '    vertex 1 0 0',
    '  endloop',
    'endfacet',
    'endsolid tetra',
  ].join('\n');
  const STL_DATA_URL = 'data:application/octet-stream;base64,' + Buffer.from(STL).toString('base64');

  await seedNotes(page, [
    makeNote({
      title: 'ModelNote',
      content: ['# ModelNote', '', '```3dmodel', STL_DATA_URL, '```', ''].join('\n'),
    }),
  ]);
  await page.goto(APP_PATH);
  await page.locator('div.group', { hasText: 'ModelNote' }).click();
  await page.getByTitle('Export').click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export current as HTML' }).click();
  const download = await downloadPromise;

  fs.mkdirSync(downloadsDir, { recursive: true });
  const savePath = path.join(downloadsDir, download.suggestedFilename());
  await download.saveAs(savePath);
  const html = fs.readFileSync(savePath, 'utf8');

  // The 3D viewport canvas must have been snapped to an embedded image.
  expect(html).not.toContain('<canvas');
  const match = html.match(/src="(data:image\/png;base64,[^"]+)"/);
  expect(match).not.toBeNull();

  // And that image must hold real pixels (a blank/transparent WebGL canvas
  // would otherwise be captured when 3D is off-screen at export time).
  const info = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    if (!ctx) return { distinct: 0, opaque: 0 };
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set<string>();
    let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) opaque++;
      colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    }
    return { distinct: colors.size, opaque };
  }, match[1]);

  expect(info.distinct).toBeGreaterThan(1);
  expect(info.opaque).toBeGreaterThan(0);

  // Non-functional interactive 3D controls must not survive into the export:
  // they can't work in a static HTML copy and would render as dead buttons or
  // leftover chrome bars over the model. (The `.model3d-export-ui` marker
  // legitimately appears in the inlined stylesheet as a fallback rule, so we
  // assert on the UI labels/buttons instead of the class name.)
  expect(html).not.toContain('Download 3D Model file');
  expect(html).not.toContain('Orbit Left');
  expect(html).not.toContain('Zoom In');
  expect(html).not.toContain('Reset Camera View');
  await step(page, 'rich-html-export-3d');
});

test('imports notes from a file', async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(page.getByRole('heading', { name: 'No note selected' })).toBeVisible();
  await debugBreak(page, 'empty state — inspect before import');

  // The sidebar has a hidden file input (accepts .md/.json/.zip) triggered by
  // the FileUp button. setInputFiles works on hidden inputs.
  await page.setInputFiles('input[type="file"]', {
    name: 'imported.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Imported Note\n\nImported body text'),
  });

  await expect(page.getByText('Imported 1 note')).toBeVisible();
  await expect(page.getByText('Imported Note', { exact: true })).toBeVisible();
  await step(page, 'imported');
});
