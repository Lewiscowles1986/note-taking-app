// Tests for src/lib/export.ts — the client-side export surface:
// single-note HTML, print-to-PDF, full JSON database backup and ZIP bundles.
//
// file-saver's saveAs is mocked so every saved artifact can be inspected by
// reading the captured Blob. JSZip is NOT mocked: it is pure JS and round-trips
// through a fresh JSZip.loadAsync() inside Node/jsdom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAs } from 'file-saver';
import type { StoredKeyPair } from '@/lib/crypto';
import { createNote, db, saveKeyPair, updateNote, type Note } from '@/lib/db';
import { exportDatabase, exportToHtml, exportToPdf, exportToZip } from '@/lib/export';

vi.mock('file-saver', () => ({ saveAs: vi.fn() }));

/** jsdom 20's Blob lacks arrayBuffer(); read the bytes through FileReader. */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

// jszip's own typings use `export = JSZip`, so the default export does not
// exist in type land (see the pre-existing TS2339 on src/lib/export.ts line 6).
// Read the produced archive back through a minimal structural view instead of
// importing the class, which keeps this file free of new compiler errors.
interface ZipEntry {
  async(type: 'string'): Promise<string>;
}

interface ZipReader {
  files: Record<string, unknown>;
  file(path: string): ZipEntry | null;
}

/** Load the bytes of a generated zip blob into a fresh JSZip instance. */
async function readZip(blob: Blob): Promise<ZipReader> {
  const jszip = (await import('jszip')) as unknown as {
    default: { loadAsync(data: ArrayBuffer): Promise<ZipReader> };
  };
  return jszip.default.loadAsync(await blobToArrayBuffer(blob));
}

/** Read a text entry or fail the test loudly instead of tripping on null. */
async function zipText(zip: ZipReader, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`missing zip entry: ${path}`);
  return entry.async('string');
}

/**
 * Pull the i-th saveAs call as a [blob, filename] pair. file-saver types the
 * first argument as `Blob | string`, so narrow it here instead of casting at
 * every use site.
 */
function savedCall(index: number): [Blob, string] {
  const call = vi.mocked(saveAs).mock.calls[index];
  if (!call) throw new Error(`saveAs was not called (missing call #${index})`);
  const [data, filename] = call;
  if (!(data instanceof Blob) || typeof filename !== 'string') {
    throw new Error(`saveAs call #${index} is not a (blob, filename) pair`);
  }
  return [data, filename];
}

const FIXED_NOW = new Date('2024-08-01T12:00:00.000Z');

/** Fully-populated note with sane defaults; override per test. */
function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    title: 'Plain note',
    content: 'just some text',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    editDates: ['2024-08-01'],
    pinned: false,
    ...overrides,
  };
}

/** Key pair fixture matching the seeding shape used in db.test.ts. */
function makeKeyPair(overrides: Partial<StoredKeyPair> = {}): StoredKeyPair {
  return {
    id: 'kp-1',
    name: 'laptop',
    fingerprint: 'FP-111',
    publicKeyJwk: { kty: 'RSA', e: 'AQAB', n: 'public-key' },
    privateKeyJwk: { kty: 'RSA', d: 'private-key' },
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

/** Wipe the fake-indexeddb database and reopen it at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(saveAs).mockClear();
});

// ─── exportToHtml ────────────────────────────────────────────────────────────

describe('exportToHtml', () => {
  it('saves the rendered note as a sanitized .html file', async () => {
    exportToHtml(
      makeNote({
        title: 'Round 6: Export!',
        tags: ['work', 'urgent'],
        category: 'Work',
        content: '# Big idea\nwith **bold** text',
        createdAt: new Date('2024-03-01T10:00:00.000Z'),
      })
    );

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = savedCall(0);
    expect(filename).toBe('Round_6__Export_.html');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('text/html;charset=utf-8');

    const html = await blob.text();
    expect(html).toContain('<title>Round 6: Export!</title>');
    expect(html).toContain('<h1>Round 6: Export!</h1>');
    expect(html).toContain('<h1>Big idea</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<span>work</span>');
    expect(html).toContain('<span>urgent</span>');
    expect(html).toContain('Category: Work');
    expect(html).toContain(new Date('2024-03-01T10:00:00.000Z').toLocaleDateString());
  });

  it('renders every markdown level and omits the tags row for untagged notes', async () => {
    exportToHtml(
      makeNote({
        title: 'Plain',
        content: '### three\n## two\n# one\nso *important* now\nnext line',
      })
    );

    const [blob] = savedCall(0);
    const html = await blob.text();
    expect(html).toContain('<h3>three</h3>');
    expect(html).toContain('<h2>two</h2>');
    expect(html).toContain('<h1>one</h1>');
    expect(html).toContain('<em>important</em>');
    expect(html).toContain('now<br/>next line');
    expect(html).not.toContain('class="tags"');
  });
});

// ─── exportToPdf ─────────────────────────────────────────────────────────────

describe('exportToPdf', () => {
  it('writes the rendered html into a popup window and prints on load', () => {
    const fakeWindow = {
      document: { write: vi.fn(), close: vi.fn() },
      print: vi.fn(),
      onload: undefined as (() => void) | undefined,
    };
    const open = vi.fn(() => fakeWindow);
    vi.stubGlobal('open', open);

    exportToPdf(makeNote({ title: 'Printable', content: '# plan' }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(fakeWindow.document.write).toHaveBeenCalledTimes(1);
    expect(fakeWindow.document.write).toHaveBeenCalledWith(
      expect.stringContaining('<title>Printable</title>')
    );
    expect(fakeWindow.document.write).toHaveBeenCalledWith(expect.stringContaining('<h1>plan</h1>'));
    expect(fakeWindow.document.close).toHaveBeenCalledTimes(1);
    // printing is deferred until the popup reports load
    expect(fakeWindow.print).not.toHaveBeenCalled();
    fakeWindow.onload?.();
    expect(fakeWindow.print).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the browser blocks the popup', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);

    expect(() => exportToPdf(makeNote({ title: 'Blocked' }))).not.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

// ─── exportDatabase ──────────────────────────────────────────────────────────

describe('exportDatabase', () => {
  beforeEach(resetDb);

  it('saves a dated JSON backup of notes, revisions and key pairs', async () => {
    const id = await createNote({
      title: 'Backup me',
      content: 'precious v1',
      tags: ['keep'],
      category: 'Work',
    });
    await updateNote(id, { content: 'precious v2' }); // writes one revision row
    await saveKeyPair(makeKeyPair());

    await exportDatabase();

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = savedCall(0);
    expect(filename).toBe(`notesapp-backup-${new Date().toISOString().slice(0, 10)}.json`);
    expect(blob.type).toBe('application/json;charset=utf-8');

    const dump = JSON.parse(await blob.text());
    expect(dump.version).toBe(4);
    expect(typeof dump.exportedAt).toBe('string');
    expect(dump.tables.notes).toHaveLength(1);
    expect(dump.tables.notes[0].title).toBe('Backup me');
    expect(dump.tables.notes[0].content).toBe('precious v2');
    expect(dump.tables.revisions).toHaveLength(1);
    expect(dump.tables.revisions[0].content).toBe('precious v1');
    expect(dump.tables.keyPairs).toHaveLength(1);
    expect(dump.tables.keyPairs[0].fingerprint).toBe('FP-111');
  });

  it('exports an empty database as three empty tables', async () => {
    await exportDatabase();

    const [blob, filename] = savedCall(0);
    expect(filename).toBe(`notesapp-backup-${new Date().toISOString().slice(0, 10)}.json`);
    const dump = JSON.parse(await blob.text());
    expect(dump.tables).toEqual({ notes: [], revisions: [], keyPairs: [] });
  });
});

// ─── exportToZip ─────────────────────────────────────────────────────────────

describe('exportToZip', () => {
  it('writes an archive containing only the notes folder for an empty list', async () => {
    await exportToZip([]);

    expect(saveAs).toHaveBeenCalledTimes(1);
    const [blob, filename] = savedCall(0);
    expect(filename).toBe('notes-export.zip');
    expect(blob.type).toBe('application/zip');

    const zip = await readZip(blob);
    expect(Object.keys(zip.files)).toEqual(['notes/']);
  });

  it('bundles html, markdown source and base64 attachments for every note', async () => {
    const report = makeNote({
      title: 'Quarterly Report!',
      tags: ['work', 'urgent'],
      category: 'Work',
      content: '# Plan\n**bold** move',
      attachments: [
        {
          id: 'a1',
          name: 'plan.txt',
          type: 'text/plain',
          data: 'data:text/plain;base64,aGVsbG8=',
          size: 5,
        },
        {
          id: 'a2',
          name: 'big.bin',
          type: 'application/octet-stream',
          data: 'https://example.com/big.bin',
          size: 9000,
        },
      ],
    });
    const plain = makeNote({ title: 'Plain', content: 'nothing here' });

    await exportToZip([report, plain]);

    const [blob, filename] = savedCall(0);
    expect(filename).toBe('notes-export.zip');

    const zip = await readZip(blob);
    expect(Object.keys(zip.files).sort()).toEqual([
      'notes/',
      'notes/Plain.html',
      'notes/Plain.md',
      'notes/Quarterly_Report_.html',
      'notes/Quarterly_Report_.md',
      'notes/Quarterly_Report__attachments/',
      'notes/Quarterly_Report__attachments/plan.txt',
    ]);

    const html = await zipText(zip, 'notes/Quarterly_Report_.html');
    expect(html).toContain('<title>Quarterly Report!</title>');
    expect(html).toContain('<h1>Plan</h1>');
    expect(html).toContain('<strong>bold</strong>');

    const md = await zipText(zip, 'notes/Quarterly_Report_.md');
    expect(md).toBe(
      '# Quarterly Report!\n\nTags: work, urgent\nCategory: Work\n\n# Plan\n**bold** move'
    );

    const plainMd = await zipText(zip, 'notes/Plain.md');
    expect(plainMd).toBe('# Plain\n\nTags: \nCategory: General\n\nnothing here');

    // data-url attachments are stored base64-decoded; remote URLs are skipped
    const attachment = await zipText(zip, 'notes/Quarterly_Report__attachments/plan.txt');
    expect(attachment).toBe('hello');
    expect(zip.file('notes/Quarterly_Report__attachments/big.bin')).toBeNull();
  });

  it('reuses the memoized jszip module across consecutive exports', async () => {
    await exportToZip([makeNote({ title: 'First note' })]);
    await exportToZip([makeNote({ title: 'Second note' })]);

    expect(saveAs).toHaveBeenCalledTimes(2);
    const zip = await readZip(savedCall(1)[0]);
    expect(await zipText(zip, 'notes/Second_note.md')).toContain('Second note');
  });
});