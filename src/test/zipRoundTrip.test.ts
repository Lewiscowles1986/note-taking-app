// Round-trip veracity tests: the export → archive bytes → import loop must
// preserve notes without loss or mutation.
//
// Unlike export.test.ts (which asserts the ZIP *layout* with a stubbed rich
// renderer) and import.test.ts (which asserts per-member parsing), these tests
// close the loop end to end: real exportToZip output is fed straight into
// importZipFile, and the re-imported notes are compared field-by-field with
// the originals. Encrypted notes are checked for the invariant that matters:
// the ciphertext payload survives byte-for-byte and no plaintext ever appears
// in the archive.
//
// The database is wiped before each test so re-imports never blend with
// stale rows.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAs } from 'file-saver';
import type { StoredKeyPair } from '@/lib/crypto';
import { db, saveKeyPair, type Note } from '@/lib/db';
import { exportDatabase, exportToZip } from '@/lib/export';
import { importDatabaseBackup, importZipFile } from '@/lib/import';

vi.mock('file-saver', () => ({ saveAs: vi.fn() }));

// The ZIP layout tests live in export.test.ts. The veracity loop only needs
// the deterministic fallback conversion, so the off-screen React renderer is
// stubbed to null (export falls back to its inline markdown conversion).
vi.mock('@/lib/exportView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exportView')>();
  return { ...actual, renderNoteViewToHtml: vi.fn().mockResolvedValue(null) };
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2024-08-01T12:00:00.000Z');

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
    encrypted: null,
    ...overrides,
  };
}

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

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(saveAs).mockClear();
});

function savedBlob(index = 0): Blob {
  const call = vi.mocked(saveAs).mock.calls[index];
  if (!call) throw new Error(`saveAs was not called (missing call #${index})`);
  const [data] = call;
  if (!(data instanceof Blob)) throw new Error(`saveAs call #${index} is not a blob`);
  return data;
}

/** jsdom 20's Blob lacks arrayBuffer(); read the bytes through FileReader. */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}

interface ZipReader {
  files: Record<string, unknown>;
  file(path: string): { async(type: 'string'): Promise<string> } | null;
}

/** Load the bytes of a generated zip blob into a fresh JSZip instance. */
async function readZip(blob: Blob): Promise<ZipReader> {
  const jszip = (await import('jszip')) as unknown as {
    default: { loadAsync(data: ArrayBuffer): Promise<ZipReader> };
  };
  return jszip.default.loadAsync(await blobToArrayBuffer(blob));
}

/** The ZIP produced by exportToZip, as a File ready for importZipFile. */
async function exportedZipAsFile(filename = 'notes-export.zip'): Promise<File> {
  const blob = savedBlob();
  return new File([await blobToArrayBuffer(blob)], filename, { type: 'application/zip' });
}

// ─── plain notes: markdown survives a ZIP round-trip ─────────────────────────

describe('plain-note ZIP round-trip (exportToZip → importZipFile)', () => {
  it('preserves title, content, tags and category byte-for-byte', async () => {
    const original = makeNote({
      title: 'Trip Report',
      content: '# Trip Report\n\nDay 1: left home.\n\nDay 2: came back.',
      tags: ['travel', '2024'],
      category: 'Journal',
    });

    await exportToZip([original]);
    const result = await importZipFile(await exportedZipAsFile());

    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(1);

    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(1);
    const roundTripped = notes[0];
    expect(roundTripped.title).toBe(original.title);
    expect(roundTripped.content).toBe(original.content);
    expect(roundTripped.tags).toEqual(original.tags);
    expect(roundTripped.category).toEqual(original.category);
  });

  it('preserves unicode content exactly (emoji + CJK round-trip)', async () => {
    const original = makeNote({
      title: 'Unicode 暗号',
      content: '🔐 加密ノート — über straße 🚀',
    });

    await exportToZip([original]);
    await importZipFile(await exportedZipAsFile());

    const [note] = await db.notes.toArray();
    expect(note?.content).toBe(original.content);
    expect(note?.title).toBe(original.title);
  });

  it('preserves markdown structure through the loop', async () => {
    const content = ['# H1 stays', '## H2 stays', '### H3 stays', '', '**bold** *em* `code` and plain.'].join('\n');
    const original = makeNote({ title: 'Markdown zoo', content });

    await exportToZip([original]);
    await importZipFile(await exportedZipAsFile());

    const [note] = await db.notes.toArray();
    // The import path stores the raw markdown body verbatim.
    expect(note?.content).toBe(original.content);
  });

  it('round-trips several notes at once (each in its own slug folder)', async () => {
    const originals = [
      makeNote({ title: 'Alpha', content: 'alpha body' }),
      makeNote({ title: 'Beta Note', content: 'beta body', tags: ['b'] }),
      makeNote({ title: 'Gamma', content: 'gamma body', category: 'Misc' }),
    ];

    await exportToZip([originals[0], originals[1], originals[2]]);
    const result = await importZipFile(await exportedZipAsFile());

    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(3);
    const byTitle = Object.fromEntries((await db.notes.toArray()).map((n) => [n.title, n]));
    expect(byTitle.Alpha?.content).toBe('alpha body');
    expect(byTitle['Beta Note']?.tags).toEqual(['b']);
    expect(byTitle.Gamma?.category).toBe('Misc');
  });

  it('preserves every note when two titles slugify to the same folder name', async () => {
    // slugify() maps "Note!" and "Note?" to the same slug; the exporter must
    // disambiguate (note, note-2, …) instead of overwriting one folder with
    // the other — which would silently drop a note from the archive.
    const first = makeNote({ title: 'Note!', content: 'first body' });
    const second = makeNote({ title: 'Note?', content: 'second body' });

    await exportToZip([first, second]);
    const zip = await readZip(savedBlob());

    // Both folders exist with intact members.
    expect(zip.file('notes/note/README.md')).not.toBeNull();
    expect(zip.file('notes/note-2/README.md')).not.toBeNull();
    expect(await zip.file('notes/note/README.md')?.async('string')).toContain('first body');
    expect(await zip.file('notes/note-2/README.md')?.async('string')).toContain('second body');

    const result = await importZipFile(await exportedZipAsFile());
    expect(result.errors).toEqual([]);
    const notes = await db.notes.toArray();
    expect(notes).toHaveLength(2);
    const bodies = notes.map((n) => n.content).sort();
    expect(bodies).toEqual(['first body', 'second body']);
  });

  it('keeps body text intact when content itself contains "---" lines', async () => {
    const original = makeNote({
      title: 'Tricky',
      content: '---\nnot frontmatter\n---\n\n{"json": "brace", "tags": "in body"}',
    });

    await exportToZip([original]);
    await importZipFile(await exportedZipAsFile());

    const [note] = await db.notes.toArray();
    // The body arrives after the parseable title/tags/category header, so its
    // own "---" lines and JSON braces are kept raw rather than eaten.
    expect(note?.content).toContain('not frontmatter');
    expect(note?.content).toContain('{"json": "brace", "tags": "in body"}');
  });
});

// ─── encrypted notes: payload fidelity, never plaintext ──────────────────────

describe('encrypted-note ZIP round-trip', () => {
  const CIPHER = 'SGVsbG8gdGhpcyBpcyBlbmNyeXB0ZWQ=';
  const IV = 'aXZlY3Rvcg==';
  const SALT = 'c2FsdA==';
  const PLAINTEXT = 'the top secret plaintext';

  function encryptedNote(overrides: Partial<Note> = {}): Note {
    return makeNote({
      title: 'Secret note',
      content: '[encrypted]',
      encrypted: {
        method: 'password',
        ciphertext: CIPHER,
        iv: 'aXZlY3Rvcg==',
        salt: 'c2FsdA==',
      },
      ...overrides,
    });
  }

  it('writes ciphertext, iv and salt byte-for-byte into both archive members', async () => {
    await exportToZip([encryptedNote()]);
    const zip = await readZip(savedBlob());

    const md = await zip.file('notes/secret-note/README.md')?.async('string');
    const html = await zip.file('notes/secret-note/secret-note.html')?.async('string');

    for (const member of [md, html]) {
      expect(member).toContain(CIPHER);
      expect(member).toContain(IV);
      expect(member).toContain(SALT);
      expect(member).not.toContain(PLAINTEXT);
      expect(member).not.toContain('[encrypted]');
    }
  });

  it('re-imports the payload text intact — recoverable with the credential', async () => {
    await exportToZip([encryptedNote()]);
    const result = await importZipFile(await exportedZipAsFile());

    expect(result.imported).toBe(1);
    const [note] = await db.notes.toArray();
    // The payload text survives the loop verbatim, so the note stays
    // recoverable with the encryption credential (no truncation or re-encode).
    expect(note?.content).toContain(CIPHER);
    expect(note?.content).toContain(IV);
    expect(note?.content).toContain(SALT);
    expect(note?.content).not.toContain(PLAINTEXT);
  });

  it('never exports plaintext even when a caller passes decrypted content on a still-encrypted note', async () => {
    // Misuse guard: a caller handing decrypted content to the exporter while
    // the note is still marked encrypted must not leak the plaintext.
    const leaked = { ...encryptedNote(), content: PLAINTEXT };
    await exportToZip([leaked]);
    const zip = await readZip(savedBlob());

    for (const path of ['notes/secret-note/README.md', 'notes/secret-note/secret-note.html']) {
      const text = await zip.file(path)?.async('string');
      expect(text).not.toContain(PLAINTEXT);
      expect(text).toContain(CIPHER);
    }
  });
});

// ─── database backup round-trip (the full-fidelity path) ─────────────────────

const PLAINTEXT_BODY = 'the secret body inside the note 🔐';
const RSA_TIMEOUT = 20_000; // RSA-4096 keygen is CPU-bound

describe('database backup round-trip (exportDatabase → importDatabaseBackup)', () => {
  it('restores a password-encrypted payload intact and still decryptable', async () => {
    const { encryptWithPassword } = await import('@/lib/crypto');
    const payload = await encryptWithPassword(PLAINTEXT_BODY, 'pw');
    const { createNote } = await import('@/lib/db');
    // exportDatabase() dumps the whole DB, so seed the note through the real
    // API before backing up.
    await createNote({
      title: 'Backup secret',
      content: '[encrypted]',
      encrypted: payload,
    });

    await exportDatabase();
    const backupFile = new File([await savedBlob().text()], 'backup.json', { type: 'application/json' });

    // Restore into an empty database (fresh-device simulation).
    await resetDb();
    const result = await importDatabaseBackup(backupFile);

    expect(result.errors).toEqual([]);
    const [note] = await db.notes.toArray();
    expect(note?.encrypted).toEqual(payload);
    expect(note?.content).toBe('[encrypted]');
    const { decryptWithPassword } = await import('@/lib/crypto');
    await expect(decryptWithPassword(note!.encrypted!, 'pw')).resolves.toBe(PLAINTEXT_BODY);
  });

  it('restores key pairs so keypair-encrypted notes stay decryptable on a fresh device', { timeout: RSA_TIMEOUT }, async () => {
    const { encryptWithPublicKey, decryptWithPrivateKey, generateKeyPair } = await import('@/lib/crypto');
    const { createNote, getKeyPairByFingerprint } = await import('@/lib/db');
    // A real RSA key pair — the fake JWK fixture cannot RSA-wrap an AES key.
    const kp = await generateKeyPair('round-trip key');
    await saveKeyPair(kp);
    const payload = await encryptWithPublicKey(PLAINTEXT_BODY, kp.publicKeyJwk);
    await createNote({ title: 'Keypair note', content: '[encrypted]', encrypted: payload });

    await exportDatabase();
    const backupFile = new File([await savedBlob().text()], 'backup.json', { type: 'application/json' });

    // Simulate a fresh device: wipe everything, restore from the backup.
    await resetDb();
    const result = await importDatabaseBackup(backupFile);
    expect(result.errors).toEqual([]);

    const [restored] = await db.notes.toArray();
    const restoredKp = await getKeyPairByFingerprint(restored!.encrypted!.keyFingerprint!);
    expect(restoredKp).toBeDefined();
    await expect(decryptWithPrivateKey(restored!.encrypted!, restoredKp!.privateKeyJwk)).resolves.toBe(PLAINTEXT_BODY);
  });
});