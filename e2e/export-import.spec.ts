import { test, expect, step, seedNotes, debugBreak, type NoteSeed } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';

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
  await page.goto('/');
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
  await page.goto('/');
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
  await page.goto('/');
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

  // 2) Integrity + contents: parse the archive with jszip (already a runtime
  //    dependency) instead of shelling out to `unzip`, which is not present in
  //    the Linux Playwright Docker image. loadAsync validates the central
  //    directory and CRCs; the entry list must include each seeded note.
  const zip = await JSZip.loadAsync(fs.readFileSync(savePath));
  const names = Object.keys(zip.files);
  expect(names).toContain('notes/ZipOne.html');
  expect(names).toContain('notes/ZipOne.md');
  expect(names).toContain('notes/ZipTwo.html');
  expect(names).toContain('notes/ZipTwo.md');

  // 3) Spot-check that the HTML entry actually parses and carries the body.
  const zipOneHtml = await zip.file('notes/ZipOne.html')!.async('string');
  expect(zipOneHtml).toContain('First zip body');
  await step(page, 'zip-export');
});

test('imports notes from a file', async ({ page }) => {
  await page.goto('/');
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
