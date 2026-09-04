// Tests for src/lib/import.ts — the client-side import surface:
// markdown files (frontmatter + the export format written by exportToZip),
// JSON note lists, ZIP bundles and full JSON database backups, plus the
// importFiles dispatcher that routes by file extension.
//
// ZIP inputs are BUILT with the real jszip library so the archive layout
// matches what exportToZip produces (notes/ folder, auto-created dir entries,
// DEFLATE members). Per-entry read failures are produced deterministically by
// XOR-scrambling one member's compressed bytes: JSZip.loadAsync() still
// resolves (the central directory is intact) but entry.async('text') rejects.
//
// Everything runs against the real Dexie database (fake-indexeddb), wiped and
// reopened before each test, so dedupe/overwrite semantics are observable.

import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Note } from '@/lib/db';
import {
  importDatabaseBackup,
  importFiles,
  importJsonFile,
  importMarkdownFile,
  importZipFile,
} from '@/lib/import';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** UTC yyyy-mm-dd key used by db.ts to bucket edit dates. */
const todayKey = (): string => new Date().toISOString().slice(0, 10);

/** Wipe the real database and reopen it fresh at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

function makeFile(text: string, name: string, type = 'application/octet-stream'): File {
  return new File([text], name, { type });
}

/** Array.from() iterates a plain array, so cast it for the FileList parameter. */
function asFileList(files: File[]): FileList {
  return files as unknown as FileList;
}

/** Fetch a note or fail the test loudly instead of tripping on `undefined`. */
async function readNote(id: number): Promise<Note> {
  const note = await db.notes.get(id);
  if (!note) throw new Error(`note ${id} not found`);
  return note;
}

/** Loose JSON shape so deliberately corrupted fixtures stay type-clean. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A minimal but realistic exportDatabase()-shaped backup as a JSON string. */
function makeBackup(parts: {
  notes?: JsonValue[];
  revisions?: JsonValue[];
  keyPairs?: JsonValue[];
}): string {
  const tables: { notes: JsonValue[]; revisions?: JsonValue[]; keyPairs?: JsonValue[] } = {
    notes: parts.notes ?? [],
  };
  if (parts.revisions) tables.revisions = parts.revisions;
  if (parts.keyPairs) tables.keyPairs = parts.keyPairs;
  return JSON.stringify({ exportedAt: '2024-08-01T00:00:00.000Z', version: 4, tables });
}

// jszip's own typings use `export = JSZip`, so reach the class through a
// structural view (same trick export.test.ts uses) to avoid new compiler errors.
interface JszipBuilder {
  file(path: string, data: string): void;
  generateAsync(options: { type: 'uint8array'; compression: string }): Promise<Uint8Array>;
}

async function jszipCtor(): Promise<{ new (): JszipBuilder }> {
  return ((await import('jszip')) as unknown as { default: { new (): JszipBuilder } }).default;
}

const u16 = (bytes: Uint8Array, off: number): number => bytes[off] | (bytes[off + 1] << 8);
const u32 = (bytes: Uint8Array, off: number): number =>
  bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);

/**
 * XOR-scramble the DEFLATE bytes of one zip member. JSZip.loadAsync() keeps
 * working (only signatures are checked) but entry.async('text') rejects with a
 * size-mismatch error — a deterministic stand-in for a corrupted archive.
 */
function corruptEntry(bytes: Uint8Array, target: string): void {
  const eocd = bytes.length - 22; // jszip writes no archive comment
  const cdStart = u32(bytes, eocd + 16);
  const count = u16(bytes, eocd + 10);
  let record = cdStart;
  for (let i = 0; i < count; i++) {
    const nameLen = u16(bytes, record + 28);
    const extraLen = u16(bytes, record + 30);
    const commentLen = u16(bytes, record + 32);
    const name = String.fromCharCode(...bytes.slice(record + 46, record + 46 + nameLen));
    if (name === target) {
      const localOffset = u32(bytes, record + 42);
      const payloadStart =
        localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
      const compSize = u32(bytes, record + 20);
      for (let k = 0; k < compSize; k++) bytes[payloadStart + k] = bytes[payloadStart + k] ^ 0xff;
      return;
    }
    record += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip entry not found for corruption: ${target}`);
}

/** Build a zip File from text entries, optionally corrupting one member. */
async function makeZip(
  entries: Array<{ name: string; text: string }>,
  corrupt?: string
): Promise<File> {
  const JSZip = await jszipCtor();
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.text);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  if (corrupt) corruptEntry(bytes, corrupt);
  return new File([bytes], 'bundle.zip', { type: 'application/zip' });
}

/** ISO timestamp reused across backup fixtures. */
const ISO_NOW = '2024-01-01T00:00:00.000Z';

beforeEach(resetDb);

// ─── importMarkdownFile ──────────────────────────────────────────────────────

describe('importMarkdownFile', () => {
  it('imports an export-format note with tags, category and feature flags', async () => {
    const file = makeFile(
      '# Weekly Report\n\nTags: work, urgent, , later\nCategory: Work\n\n' +
        'Some **content** here.\n\n```mermaid\ngraph TD; A-->B;\n```',
      'weekly.md',
      'text/markdown'
    );

    const result = await importMarkdownFile(file);

    expect(result).toEqual({ imported: 1, errors: [] });
    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Weekly Report');
    expect(notes[0].tags).toEqual(['work', 'urgent', 'later']); // empty items dropped
    expect(notes[0].category).toBe('Work');
    expect(notes[0].content).toBe('Some **content** here.\n\n```mermaid\ngraph TD; A-->B;\n```');
    expect(notes[0].hasMermaid).toBe(true);
    expect(notes[0].hasCodeBlocks).toBe(false);
    expect(notes[0].createdAt).toBeInstanceOf(Date);
    expect(notes[0].editDates).toEqual([todayKey()]);
  });

  it('lets frontmatter override title, tags and category and skips malformed lines', async () => {
    const raw = [
      '---',
      'Title:   From Frontmatter  ',
      'tags: fm-a, fm-b, , fm-c',
      'category: Front Category',
      'description: :weird-value',
      'badline no colon', // no ':' at all → ignored
      ':zerocolon', // ':' at position 0 → ignored
      '---',
      'Body starts here',
    ].join('\n');

    const result = await importMarkdownFile(makeFile(raw, 'fm.md', 'text/markdown'));

    expect(result).toEqual({ imported: 1, errors: [] });
    const notes = await db.notes.toArray();
    expect(notes[0].title).toBe('From Frontmatter'); // key lowercased, value trimmed
    expect(notes[0].tags).toEqual(['fm-a', 'fm-b', 'fm-c']);
    expect(notes[0].category).toBe('Front Category');
    expect(notes[0].content).toBe('Body starts here');
  });

  it('imports headingless markdown as Untitled and trims leading blank lines', async () => {
    const result = await importMarkdownFile(
      makeFile('\n\njust plain text\nsecond line', 'my-notes-file.md', 'text/markdown')
    );

    expect(result).toEqual({ imported: 1, errors: [] });
    const note = await readNote(1);
    expect(note.title).toBe('Untitled'); // parseExportFormat always yields a title
    expect(note.content).toBe('just plain text\nsecond line');
    expect(note.tags).toEqual([]);
    expect(note.category).toBe('General');
  });

  it('falls back to the raw body when trailing blanks make parsed content empty', async () => {
    const result = await importMarkdownFile(makeFile('# Only Heading\n', 'only.md', 'text/markdown'));

    expect(result).toEqual({ imported: 1, errors: [] });
    const note = await readNote(1);
    expect(note.title).toBe('Only Heading');
    expect(note.content).toBe('# Only Heading\n'); // parsed.content was '' → body used
  });

  it('falls back to the filename when the heading line is empty', async () => {
    // '# ' parses as an EMPTY title (parseExportFormat trims the heading),
    // which is falsy and lets the file name supply the note title
    const result = await importMarkdownFile(makeFile('# \n', 'named-file.md', 'text/markdown'));

    expect(result).toEqual({ imported: 1, errors: [] });
    const note = await readNote(1);
    expect(note.title).toBe('named-file');
    expect(note.content).toBe('# \n'); // parsed content was '' → body used
  });

  it('keeps the whole body when frontmatter is never closed', async () => {
    const result = await importMarkdownFile(
      makeFile('---\ntitle: never closed\nbody continues', 'loose.md', 'text/markdown')
    );

    expect(result).toEqual({ imported: 1, errors: [] });
    const note = await readNote(1);
    expect(note.title).toBe('Untitled'); // no frontmatter parsed, no heading
    expect(note.content).toBe('---\ntitle: never closed\nbody continues');
  });

  it('reports an error when the file cannot be read', async () => {
    const broken = { name: 'broken.md', text: undefined } as unknown as File;

    const result = await importMarkdownFile(broken);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to import broken.md');
    expect(result.errors[0]).toContain('TypeError');
  });
});

// ─── importJsonFile ──────────────────────────────────────────────────────────

describe('importJsonFile', () => {
  it('imports an array of notes applying defaults and feature detection', async () => {
    const items = [
      {
        title: 'Full',
        content: '```js\nconst a = 1;\n```',
        tags: ['x'],
        category: 'Code',
        attachments: [
          { id: 'a1', name: 'snap.txt', type: 'text/plain', data: 'data:text/plain;base64,aGk=', size: 2 },
        ],
        pinned: true,
      },
      { content: 'minimal body' }, // no title → Untitled, no tags/category
      { title: 'No content' }, // content absent → ''
    ];

    const result = await importJsonFile(makeFile(JSON.stringify(items), 'notes.json', 'application/json'));

    expect(result).toEqual({ imported: 3, errors: [] });
    const notes = await db.notes.toArray();
    expect(notes.map((n) => n.title)).toEqual(['Full', 'Untitled', 'No content']);
    expect(notes[0].hasCodeBlocks).toBe(true);
    expect(notes[0].attachments).toEqual([
      { id: 'a1', name: 'snap.txt', type: 'text/plain', data: 'data:text/plain;base64,aGk=', size: 2 },
    ]);
    expect(notes[0].pinned).toBe(true);
    expect(notes[1].content).toBe('minimal body');
    expect(notes[1].tags).toEqual([]);
    expect(notes[1].category).toBe('General');
    expect(notes[2].content).toBe('');
    expect(notes[2].attachments).toEqual([]);
    expect(notes[2].pinned).toBe(false);
  });

  it('imports a single object and discards malformed field types', async () => {
    const data = { title: 'Solo', tags: 'not-array', category: '', attachments: 'no', content: 'body' };

    const result = await importJsonFile(makeFile(JSON.stringify(data), 'solo.json', 'application/json'));

    expect(result).toEqual({ imported: 1, errors: [] });
    const note = await readNote(1);
    expect(note.title).toBe('Solo');
    expect(note.tags).toEqual([]); // non-array tags discarded
    expect(note.category).toBe('General'); // empty string falls back
    expect(note.attachments).toEqual([]); // non-array attachments discarded
    expect(note.content).toBe('body');
  });

  it('appends duplicates without dedupe when the same file is imported twice', async () => {
    const file = makeFile(JSON.stringify({ title: 'Dup', content: 'x' }), 'dup.json', 'application/json');

    const first = await importJsonFile(file);
    const second = await importJsonFile(file);

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(1);
    expect(await db.notes.count()).toBe(2); // no upsert: both rows kept
  });

  it('reports a per-note failure and keeps importing the rest', async () => {
    const good = { title: 'Good', content: 'fine' };
    // content object without a working toString makes the feature-detection
    // regex blow up inside the per-note try block
    const poisoned = { title: 'Poisoned', content: { toString: null } };

    const result = await importJsonFile(
      makeFile(JSON.stringify([good, poisoned]), 'mixed.json', 'application/json')
    );

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to import note "Poisoned"');
    expect(result.errors[0]).toContain('TypeError');
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Good']);
  });

  it('reports malformed JSON', async () => {
    const result = await importJsonFile(makeFile('{"broken":', 'bad.json', 'application/json'));

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse JSON');
    expect(await db.notes.count()).toBe(0);
  });
});

// ─── importZipFile ───────────────────────────────────────────────────────────

describe('importZipFile', () => {
  it('imports markdown and json members and skips every other file type', async () => {
    const zip = await makeZip([
      { name: 'notes/Hello.md', text: '# Hello Note\n\nTags: from-zip\nCategory: ZipCat\n\nzipped body' },
      { name: 'notes/data.json', text: JSON.stringify([{ title: 'Json One', content: 'one body' }, { title: 'Json Two', content: 'two body' }]) },
      { name: 'notes/Hello.html', text: '<html>ignored</html>' },
      { name: 'readme.txt', text: 'ignore me' },
    ]);

    const result = await importZipFile(zip);

    expect(result).toEqual({ imported: 3, errors: [] });
    const notes = await db.notes.toArray();
    expect(notes.map((n) => n.title)).toEqual(['Hello Note', 'Json One', 'Json Two']);
    expect(notes[0].content).toBe('zipped body');
    expect(notes[0].tags).toEqual(['from-zip']);
    expect(notes[0].category).toBe('ZipCat');
  });

  it('returns zero for an archive without importable members', async () => {
    const zip = await makeZip([
      { name: 'notes/Only.html', text: '<html>x</html>' },
      // a member whose basename is empty reaches the `|| entry.name` fallback
      { name: 'weird/', text: 'trailing slash' },
    ]);

    const result = await importZipFile(zip);

    expect(result).toEqual({ imported: 0, errors: [] });
    expect(await db.notes.count()).toBe(0);
  });

  it('reports a per-member read failure for corrupt markdown and imports the rest', async () => {
    const zip = await makeZip([
      { name: 'bad.md', text: '# Bad\n\nsome body text to deflate' },
      { name: 'ok.json', text: JSON.stringify([{ title: 'Ok', content: 'fine' }]) },
    ], 'bad.md');

    const result = await importZipFile(zip);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to read bad.md');
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Ok']);
  });

  it('reports a per-member read failure for corrupt json and imports the rest', async () => {
    const zip = await makeZip([
      { name: 'ok.md', text: '# Ok Md\n\nplain body' },
      { name: 'bad.json', text: JSON.stringify([{ title: 'Ok', content: 'fine' }]) },
    ], 'bad.json');

    const result = await importZipFile(zip);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to read bad.json');
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Ok Md']);
  });

  it('reports a failure for files that are not zip archives at all', async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], 'nope.zip');

    const result = await importZipFile(garbage);

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to read ZIP');
    expect(await db.notes.count()).toBe(0);
  });

  it('reuses the memoized jszip module across consecutive imports', async () => {
    const first = await makeZip([{ name: 'a.md', text: '# A One\n\nbody a' }]);
    const second = await makeZip([
      { name: 'b.json', text: JSON.stringify([{ title: 'B Two', content: 'body b' }]) },
    ]);

    await importZipFile(first);
    await importZipFile(second);

    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['A One', 'B Two']);
  });
});

// ─── importDatabaseBackup ────────────────────────────────────────────────────

describe('importDatabaseBackup', () => {
  it('restores notes, revisions and key pairs from a full backup', async () => {
    const backup = makeBackup({
      notes: [
        {
          id: 42,
          title: 'Full Note',
          content: 'rich body',
          tags: ['keep'],
          category: 'Backup',
          attachments: [
            { id: 'a1', name: 'inline.txt', type: 'text/plain', data: 'data:text/plain;base64,aGk=', size: 2 },
            { id: 'a2', name: 'remote.bin', type: 'application/octet-stream', data: 'https://example.com/remote.bin', size: 9000 },
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-02-02T00:00:00.000Z',
          editDates: ['2024-01-01'],
          pinned: true,
          encrypted: null,
        },
        // sparse note exercises the "|| default" branches for every field
        { id: 7, title: 'Sparse Note', createdAt: ISO_NOW, updatedAt: ISO_NOW },
      ],
      revisions: [
        { id: 900, noteId: 42, title: 'Full Note', content: 'old body', tags: ['keep'], category: 'Backup', savedAt: '2024-01-05T10:00:00.000Z' },
        null, // unreadable row → skipped silently
      ],
      keyPairs: [
        { id: 'kp-1', name: 'laptop', fingerprint: 'FP-111', publicKeyJwk: { kty: 'RSA', e: 'AQAB', n: 'pub' }, privateKeyJwk: { kty: 'RSA', d: 'priv' }, createdAt: ISO_NOW },
        {}, // no id → put() rejects → skipped silently
      ],
    });

    const result = await importDatabaseBackup(makeFile(backup, 'backup.json', 'application/json'));

    expect(result).toEqual({ imported: 2, errors: [] });

    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(2);
    expect(notes[0].id).toBe(1); // backup ids are NOT preserved — auto re-assigned
    expect(notes[0].createdAt).toBeInstanceOf(Date);
    expect(notes[0].createdAt.getTime()).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(notes[0].updatedAt.getTime()).toBe(Date.parse('2024-02-02T00:00:00.000Z'));
    expect(notes[0].attachments).toEqual([
      { id: 'a1', name: 'inline.txt', type: 'text/plain', data: 'data:text/plain;base64,aGk=', size: 2 },
      { id: 'a2', name: 'remote.bin', type: 'application/octet-stream', data: 'https://example.com/remote.bin', size: 9000 },
    ]);
    expect(notes[0].tags).toEqual(['keep']);
    expect(notes[0].category).toBe('Backup');
    expect(notes[0].pinned).toBe(true);
    expect(notes[1].id).toBe(2);
    expect(notes[1].attachments).toEqual([]);
    expect(notes[1].tags).toEqual([]);
    expect(notes[1].editDates).toEqual([]);
    expect(notes[1].pinned).toBe(false);

    const revisions = await db.revisions.toArray();
    expect(revisions).toHaveLength(1); // the null row was skipped silently
    expect(revisions[0].savedAt).toBeInstanceOf(Date);
    expect(revisions[0].savedAt.getTime()).toBe(Date.parse('2024-01-05T10:00:00.000Z'));
    expect(revisions[0].noteId).toBe(42); // original noteId kept verbatim, not remapped
    expect(revisions[0].id).not.toBe(900); // revision ids re-assigned as well

    const keyPairs = await db.keyPairs.toArray();
    expect(keyPairs).toHaveLength(1); // the {} row was rejected silently
    expect(keyPairs[0].id).toBe('kp-1'); // keyPair ids ARE preserved (put upserts by id)
    expect(keyPairs[0].fingerprint).toBe('FP-111');
    expect(keyPairs[0].createdAt).toBe(ISO_NOW); // stored as-is, not converted back to Date
  });

  it('rejects files without a notes table', async () => {
    for (const text of ['{}', '{"tables":{}}', '{"tables":{"notes":"nope"}}']) {
      const result = await importDatabaseBackup(makeFile(text, 'backup.json', 'application/json'));
      expect(result).toEqual({ imported: 0, errors: ['Not a valid database backup file'] });
    }
    expect(await db.notes.count()).toBe(0);
  });

  it('treats a backup with an empty notes table as a no-op', async () => {
    const result = await importDatabaseBackup(makeFile(makeBackup({}), 'backup.json', 'application/json'));

    expect(result).toEqual({ imported: 0, errors: [] });
    expect(await db.notes.count()).toBe(0);
  });

  it('aborts the revisions/keyPairs sections when a note row cannot be imported', async () => {
    const backup = makeBackup({
      notes: [
        { id: 42, title: 'Good', content: 'c', createdAt: ISO_NOW, updatedAt: ISO_NOW },
        null, // unreadable row → the catch re-throws while building the message
      ],
      revisions: [
        { id: 1, noteId: 42, title: 'r', content: '', tags: [], category: 'c', savedAt: ISO_NOW },
      ],
      keyPairs: [
        { id: 'kp-9', name: 'n', fingerprint: 'FP-9', publicKeyJwk: {}, privateKeyJwk: {}, createdAt: ISO_NOW },
      ],
    });

    const result = await importDatabaseBackup(makeFile(backup, 'backup.json', 'application/json'));

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse backup');
    // the good note landed before the failure…
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Good']);
    // …but the revisions/keyPairs sections never ran
    expect(await db.revisions.count()).toBe(0);
    expect(await db.keyPairs.count()).toBe(0);
  });

  it('reports malformed backup JSON', async () => {
    const result = await importDatabaseBackup(makeFile('not json at all', 'backup.json', 'application/json'));

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Failed to parse backup');
    expect(await db.notes.count()).toBe(0);
  });

  it('upserts key pairs on re-import while notes and revisions are duplicated', async () => {
    const backup = makeBackup({
      notes: [{ id: 42, title: 'Once', content: 'c', createdAt: ISO_NOW, updatedAt: ISO_NOW }],
      revisions: [
        { id: 1, noteId: 42, title: 'Once', content: 'c', tags: [], category: 'General', savedAt: ISO_NOW },
      ],
      keyPairs: [
        { id: 'kp-1', name: 'n', fingerprint: 'FP-1', publicKeyJwk: {}, privateKeyJwk: {}, createdAt: ISO_NOW },
      ],
    });

    await importDatabaseBackup(makeFile(backup, 'backup.json', 'application/json'));
    const second = await importDatabaseBackup(makeFile(backup, 'backup.json', 'application/json'));

    expect(second.imported).toBe(1);
    expect(await db.notes.count()).toBe(2); // appended, never deduped
    expect(await db.revisions.count()).toBe(2); // ids are stripped, so "duplicates" re-add
    expect(await db.keyPairs.count()).toBe(1); // put() upserts by id
    expect((await db.keyPairs.toArray())[0].fingerprint).toBe('FP-1');
  });
});

// ─── importFiles dispatcher ──────────────────────────────────────────────────

describe('importFiles', () => {
  it('routes by extension and accumulates results across the batch', async () => {
    const files = [
      makeFile('# Dispatch One\n\nplain body', 'note.md', 'text/markdown'),
      makeFile('plain markdown body', 'notes.markdown', 'text/markdown'),
      makeFile('hello', 'photo.txt'),
      makeFile('{"broken"', 'broken.json', 'application/json'),
    ];

    const result = await importFiles(asFileList(files));

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('Unsupported file type: photo.txt');
    expect(result.errors[1]).toContain('Failed to parse JSON');
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Dispatch One', 'Untitled']);
  });

  it('routes a .json file to the database-backup importer when tables.notes exists', async () => {
    const backup = makeBackup({
      notes: [{ id: 42, title: 'Via Dispatcher', content: 'c', createdAt: ISO_NOW, updatedAt: ISO_NOW }],
    });

    const result = await importFiles(asFileList([makeFile(backup, 'backup.json', 'application/json')]));

    expect(result).toEqual({ imported: 1, errors: [] });
    const note = await readNote(1);
    expect(note.title).toBe('Via Dispatcher');
    expect(note.createdAt).toBeInstanceOf(Date);
  });

  it('routes a .json file to the plain importer when tables.notes is missing', async () => {
    const result = await importFiles(
      asFileList([makeFile('{"tables":{"notes":"nope"}}', 'odd.json', 'application/json')])
    );

    expect(result).toEqual({ imported: 1, errors: [] });
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Untitled']);
  });

  it('routes a .zip file through the zip importer', async () => {
    const zip = await makeZip([{ name: 'z.md', text: '# Zipped Dispatch\n\nbody' }]);

    const result = await importFiles(asFileList([zip]));

    expect(result).toEqual({ imported: 1, errors: [] });
    expect((await db.notes.toArray()).map((n) => n.title)).toEqual(['Zipped Dispatch']);
  });
});