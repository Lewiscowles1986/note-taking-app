import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import type { StoredKeyPair } from '@/lib/crypto';
import {
  MAX_INLINE_SIZE,
  createNote,
  db,
  deleteKeyPair,
  deleteNote,
  fileToDataUrl,
  getAllCategories,
  getAllKeyPairs,
  getAllNotes,
  getAllTags,
  getKeyPairByFingerprint,
  getNotesByCategory,
  getNotesByTag,
  getRevisions,
  saveKeyPair,
  searchNotes,
  updateNote,
  type Note,
  type NoteAttachment,
  type NoteRevision,
} from '@/lib/db';

/** UTC yyyy-mm-dd key used by db.ts to bucket edit dates. */
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Date `days` from today, pinned to noon UTC so date keys stay stable. */
const day = (days: number): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

/** Today's UTC date key, computed the same way db.ts does. */
const todayKey = (): string => isoDate(new Date());

/** Wipe the real database and reopen it fresh at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

/** Fetch a note or fail the test loudly instead of tripping on `undefined`. */
async function readNote(id: number): Promise<Note> {
  const note = await db.notes.get(id);
  if (!note) throw new Error(`note ${id} not found`);
  return note;
}

/** Shape of a note record as it exists in a legacy (pre-v3) database. */
interface LegacyNote {
  title: string;
  content: string;
  tags: string[];
  category: string;
  attachments: NoteAttachment[];
  createdAt?: Date;
  updatedAt: Date;
  pinned: boolean;
  hasCodeBlocks?: boolean;
  hasMermaid?: boolean;
}

// ─── Migrations: replay upgrade callbacks from historical versions ──────────

describe('NotesDatabase migrations (replayed from historical versions)', () => {
  it('is registered as NotesApp at v4', () => {
    expect(db.name).toBe('NotesApp');
    expect(db.verno).toBe(4);
  });

  it('replays v2 (content-feature flags) and v3 (editDates) upgrades over a v1 database', async () => {
    // Build a database at the historical v1 shape, then let the real singleton
    // open it and run every registered upgrade callback in order.
    const legacy = new Dexie('NotesApp');
    legacy.version(1).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned',
    });
    const legacyNotes = legacy.table<LegacyNote, number>('notes');
    const idCode = await legacyNotes.add({
      title: 'Code note',
      content: 'Text\n```javascript\nconst x = 1;\n```\nEnd',
      tags: ['code'],
      category: 'Tech',
      attachments: [],
      createdAt: new Date('2024-01-01T10:00:00.000Z'),
      updatedAt: new Date('2024-03-05T10:00:00.000Z'),
      pinned: false,
    });
    const idMermaid = await legacyNotes.add({
      title: 'Mermaid note',
      content: '```mermaid\ngraph TD\nA-->B\n```',
      tags: [],
      category: 'Tech',
      attachments: [],
      createdAt: new Date('2024-02-10T08:00:00.000Z'),
      updatedAt: new Date('2024-02-10T20:00:00.000Z'),
      pinned: false,
    });
    const idPlain = await legacyNotes.add({
      title: 'Plain note',
      content: 'Just text with `inline code`',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: new Date('2024-05-01T06:00:00.000Z'),
      updatedAt: new Date('2024-05-01T18:00:00.000Z'),
      pinned: true,
    });
    const idNoCreated = await legacyNotes.add({
      title: 'No createdAt note',
      content: 'survives the guard',
      tags: [],
      category: 'General',
      attachments: [],
      updatedAt: new Date('2024-04-01T00:30:00.000Z'),
      pinned: false,
    });
    await legacy.close();

    await db.open(); // v1 → v4: runs the v2 then v3 upgrade callbacks

    expect(db.verno).toBe(4);

    const codeNote = await readNote(idCode);
    expect(codeNote.hasCodeBlocks).toBe(true);
    expect(codeNote.hasMermaid).toBe(false);
    expect(codeNote.editDates).toEqual(['2024-01-01', '2024-03-05']);

    const mermaidNote = await readNote(idMermaid);
    expect(mermaidNote.hasMermaid).toBe(true);
    expect(mermaidNote.hasCodeBlocks).toBe(false);

    const plainNote = await readNote(idPlain);
    expect(plainNote.hasCodeBlocks).toBe(false);
    expect(plainNote.hasMermaid).toBe(false);
    expect(plainNote.editDates).toEqual(['2024-05-01']); // same-day timestamps de-duplicated

    const noCreatedNote = await readNote(idNoCreated);
    expect(noCreatedNote.editDates).toEqual(['2024-04-01']); // missing createdAt guarded

    // Original data survived both migrations.
    expect(codeNote.title).toBe('Code note');
    expect(codeNote.tags).toEqual(['code']);
    expect(plainNote.pinned).toBe(true);

    // Tables introduced by v3 and v4 exist and are empty.
    expect(await db.revisions.count()).toBe(0);
    expect(await db.keyPairs.count()).toBe(0);
  });

  it('replays the v3 editDates upgrade over a v2 database without re-running v2', async () => {
    await db.delete();
    const legacy = new Dexie('NotesApp');
    legacy.version(2).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned',
    });
    const legacyNotes = legacy.table<LegacyNote, number>('notes');
    const id = await legacyNotes.add({
      title: 'Flagged note',
      content: 'plain',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: new Date('2024-06-01T08:00:00.000Z'),
      updatedAt: new Date('2024-06-01T20:00:00.000Z'),
      pinned: false,
      hasCodeBlocks: true,
      hasMermaid: false,
    });
    await legacy.close();

    await db.open(); // v2 → v4: only the v3 upgrade callback runs

    const note = await readNote(id);
    expect(note.editDates).toEqual(['2024-06-01']);
    expect(note.hasCodeBlocks).toBe(true); // v2-era flags are preserved, not recomputed
    expect(note.hasMermaid).toBe(false);
  });

  it('adds the keyPairs store when upgrading a v3 database to v4', async () => {
    await db.delete();
    const legacy = new Dexie('NotesApp');
    legacy.version(3).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned, *editDates',
      revisions: '++id, noteId, savedAt',
    });
    const legacyNotes = legacy.table<LegacyNote, number>('notes');
    const id = await legacyNotes.add({
      title: 'Survivor',
      content: 'kept',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: new Date('2024-07-01T08:00:00.000Z'),
      updatedAt: new Date('2024-07-02T09:00:00.000Z'),
      pinned: true,
    });
    const legacyRevisions = legacy.table<NoteRevision, number>('revisions');
    await legacyRevisions.add({
      noteId: id,
      title: 'Survivor',
      content: 'older revision',
      tags: [],
      category: 'General',
      savedAt: new Date('2024-07-01T08:30:00.000Z'),
    });
    await legacy.close();

    await db.open(); // v3 → v4: creates keyPairs, no data rewrite

    expect(db.verno).toBe(4);
    // A database born at v3 never runs the v3 upgrade callback (it only fires
    // when moving INTO v3 — see the v1 and v2 replay tests above), so its
    // records pass through untouched.
    const note = await readNote(id);
    expect(note.title).toBe('Survivor');
    expect(note.pinned).toBe(true);
    expect(await db.keyPairs.count()).toBe(0); // v4 store exists
    expect(await db.revisions.where('noteId').equals(id).count()).toBe(1);
  });
});

// ─── Key pair CRUD ───────────────────────────────────────────────────────────

describe('key pair CRUD', () => {
  beforeEach(resetDb);

  function makeKeyPair(overrides: Partial<StoredKeyPair> = {}): StoredKeyPair {
    return {
      id: 'kp-1',
      name: 'laptop',
      fingerprint: 'FP-111',
      publicKeyJwk: { kty: 'RSA', e: 'AQAB', n: 'public-key' },
      privateKeyJwk: { kty: 'RSA', d: 'private-key' },
      createdAt: day(-1),
      ...overrides,
    };
  }

  it('saveKeyPair stores and getAllKeyPairs lists key pairs', async () => {
    await saveKeyPair(makeKeyPair());
    await saveKeyPair(makeKeyPair({ id: 'kp-2', name: 'phone', fingerprint: 'FP-222' }));
    const all = await getAllKeyPairs();
    expect(all.map((kp) => kp.id).sort()).toEqual(['kp-1', 'kp-2']);
    expect(all.map((kp) => kp.fingerprint).sort()).toEqual(['FP-111', 'FP-222']);
  });

  it('saveKeyPair overwrites an existing id (put semantics)', async () => {
    await saveKeyPair(makeKeyPair());
    await saveKeyPair(makeKeyPair({ name: 'laptop-renamed' }));
    const all = await getAllKeyPairs();
    expect(all).toHaveLength(1);
    expect(all.map((kp) => kp.name)).toEqual(['laptop-renamed']);
  });

  it('getKeyPairByFingerprint finds a key pair by fingerprint', async () => {
    await saveKeyPair(makeKeyPair());
    const found = await getKeyPairByFingerprint('FP-111');
    expect(found?.id).toBe('kp-1');
    expect(found?.name).toBe('laptop');
    expect(await getKeyPairByFingerprint('FP-UNKNOWN')).toBeUndefined();
  });

  it('deleteKeyPair removes a key pair and is a no-op when absent', async () => {
    await saveKeyPair(makeKeyPair());
    await deleteKeyPair('kp-1');
    expect(await getAllKeyPairs()).toEqual([]);
    await expect(deleteKeyPair('kp-1')).resolves.toBeUndefined();
  });
});

// ─── Note CRUD ───────────────────────────────────────────────────────────────

describe('note CRUD', () => {
  beforeEach(resetDb);

  function noteOverrides(overrides: Partial<Note> = {}): Partial<Note> {
    return {
      title: 'Test note',
      content: 'hello world',
      tags: ['work'],
      category: 'Projects',
      createdAt: day(-3),
      updatedAt: day(-3),
      ...overrides,
    };
  }

  it('createNote fills in defaults', async () => {
    const id = await createNote();
    expect(typeof id).toBe('number');
    const note = await readNote(id);
    expect(note.title).toBe('Untitled');
    expect(note.content).toBe('');
    expect(note.tags).toEqual([]);
    expect(note.category).toBe('General');
    expect(note.attachments).toEqual([]);
    expect(note.pinned).toBe(false);
    expect(note.encrypted).toBeNull();
    expect(note.editDates).toEqual([todayKey()]);
    expect(note.createdAt).toBeInstanceOf(Date);
    expect(note.updatedAt).toBeInstanceOf(Date);
  });

  it('createNote honours overrides and assigns distinct ids', async () => {
    const attachments: NoteAttachment[] = [
      { id: 'a1', name: 'plan.png', type: 'image/png', data: 'data:image/png;base64,AAA', size: 3 },
    ];
    const id1 = await createNote(noteOverrides({ title: 'First', createdAt: day(-2), updatedAt: day(-2) }));
    const id2 = await createNote(
      noteOverrides({ title: 'Second', attachments, pinned: true, createdAt: day(-1), updatedAt: day(-1) })
    );
    expect(id1).not.toBe(id2);

    const second = await readNote(id2);
    expect(second.title).toBe('Second');
    expect(second.attachments).toEqual(attachments);
    expect(second.pinned).toBe(true);
    expect(second.createdAt).toEqual(day(-1));

    const first = await readNote(id1);
    expect(first.title).toBe('First');
    expect(first.pinned).toBe(false);
  });

  it('updateNote snapshots a revision, applies changes and tracks editDates', async () => {
    const id = await createNote(
      noteOverrides({ title: 'Before', content: 'v1', tags: ['work'], editDates: [isoDate(day(-3))] })
    );
    const count = await updateNote(id, { title: 'After', content: 'v2', tags: ['work', 'urgent'] });
    expect(count).toBe(1);

    const note = await readNote(id);
    expect(note.title).toBe('After');
    expect(note.content).toBe('v2');
    expect(note.tags).toEqual(['work', 'urgent']);
    expect(note.category).toBe('Projects'); // untouched field survives
    expect(note.editDates).toEqual([isoDate(day(-3)), todayKey()]);
    expect(note.updatedAt).toBeInstanceOf(Date);
    expect(note.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    const revisions = await db.revisions.where('noteId').equals(id).toArray();
    expect(revisions.map((r) => r.title)).toEqual(['Before']);
    expect(revisions.map((r) => r.content)).toEqual(['v1']);
    expect(revisions.map((r) => r.tags)).toEqual([['work']]);
    expect(revisions.map((r) => r.category)).toEqual(['Projects']);
    expect(revisions.map((r) => r.noteId)).toEqual([id]);
    expect(revisions.map((r) => r.savedAt instanceof Date)).toEqual([true]);
  });

  it('updateNote on a missing note is a no-op that returns undefined', async () => {
    const result = await updateNote(424242, { title: 'Ghost' });
    expect(result).toBeUndefined();
    expect(await db.revisions.count()).toBe(0);
    expect(await db.notes.count()).toBe(0);
  });

  it('updateNote tolerates legacy notes without editDates', async () => {
    const id = await db.notes.add({
      title: 'Raw',
      content: '',
      tags: [],
      category: 'General',
      attachments: [],
      createdAt: day(-1),
      updatedAt: day(-1),
      pinned: false,
    } as Note);
    await updateNote(id, { title: 'Raw 2' });
    const note = await readNote(id);
    expect(note.title).toBe('Raw 2');
    expect(note.editDates).toEqual([todayKey()]);
  });

  it('deleteNote removes the note and its revisions', async () => {
    const id = await createNote();
    await updateNote(id, { title: 'Second version' }); // creates one revision
    await deleteNote(id);
    expect(await db.notes.get(id)).toBeUndefined();
    expect(await db.revisions.where('noteId').equals(id).count()).toBe(0);
    expect(await getAllNotes()).toEqual([]);
  });

  it('getRevisions returns snapshots newest-first and [] for unknown notes', async () => {
    const id = await createNote();
    await db.revisions.bulkAdd([
      { noteId: id, title: 'oldest', content: '1', tags: [], category: 'General', savedAt: day(-3) },
      { noteId: id, title: 'newest', content: '3', tags: [], category: 'General', savedAt: day(-1) },
      { noteId: id, title: 'middle', content: '2', tags: [], category: 'General', savedAt: day(-2) },
    ]);
    const revisions = await getRevisions(id);
    expect(revisions.map((r) => r.title)).toEqual(['newest', 'middle', 'oldest']);
    expect(await getRevisions(id + 999)).toEqual([]);
  });
});

// ─── Query helpers ───────────────────────────────────────────────────────────

describe('note query helpers', () => {
  beforeEach(resetDb);

  interface SeedSpec {
    title: string;
    content?: string;
    tags?: string[];
    category?: string;
    updatedAt: Date;
  }

  async function seedNotes(specs: SeedSpec[]): Promise<void> {
    for (const spec of specs) {
      await createNote({
        title: spec.title,
        content: spec.content ?? 'body text',
        tags: spec.tags ?? [],
        category: spec.category ?? 'General',
        createdAt: spec.updatedAt,
        updatedAt: spec.updatedAt,
      });
    }
  }

  it('getAllNotes orders by updatedAt newest-first', async () => {
    await seedNotes([
      { title: 'oldest', updatedAt: day(-5) },
      { title: 'newest', updatedAt: day(-1) },
      { title: 'middle', updatedAt: day(-3) },
    ]);
    expect((await getAllNotes()).map((n) => n.title)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('searchNotes matches title, content and tags case-insensitively', async () => {
    await seedNotes([
      { title: 'Quarterly report', content: 'budget numbers', tags: ['finance'], updatedAt: day(-3) },
      { title: 'Scratch pad', content: 'holds the needle inside', tags: [], updatedAt: day(-2) },
      { title: 'Ideas', content: 'nothing to see', tags: ['react-hooks'], updatedAt: day(-1) },
    ]);
    expect((await searchNotes('quarterly')).map((n) => n.title)).toEqual(['Quarterly report']);
    expect((await searchNotes('REPORT')).map((n) => n.title)).toEqual(['Quarterly report']);
    expect((await searchNotes('needle')).map((n) => n.title)).toEqual(['Scratch pad']);
    expect((await searchNotes('react')).map((n) => n.title)).toEqual(['Ideas']);
    expect((await searchNotes('FINANCE')).map((n) => n.title)).toEqual(['Quarterly report']);
    expect(await searchNotes('no-such-term')).toEqual([]);
  });

  it('getNotesByTag filters on the multiEntry tags index, newest-first', async () => {
    await seedNotes([
      { title: 'old tagged', tags: ['shared', 'other'], updatedAt: day(-4) },
      { title: 'new tagged', tags: ['shared'], updatedAt: day(-2) },
      { title: 'untagged', tags: [], updatedAt: day(-1) },
    ]);
    expect((await getNotesByTag('shared')).map((n) => n.title)).toEqual(['new tagged', 'old tagged']);
    expect((await getNotesByTag('other')).map((n) => n.title)).toEqual(['old tagged']);
    expect(await getNotesByTag('missing')).toEqual([]);
  });

  it('getNotesByCategory filters on the category index, newest-first', async () => {
    await seedNotes([
      { title: 'home a', category: 'Home', updatedAt: day(-3) },
      { title: 'home b', category: 'Home', updatedAt: day(-1) },
      { title: 'work', category: 'Work', updatedAt: day(-2) },
    ]);
    expect((await getNotesByCategory('Home')).map((n) => n.title)).toEqual(['home b', 'home a']);
    expect((await getNotesByCategory('Work')).map((n) => n.title)).toEqual(['work']);
    expect(await getNotesByCategory('Missing')).toEqual([]);
  });

  it('getAllTags returns a sorted, de-duplicated tag list', async () => {
    await seedNotes([
      { title: 'a', tags: ['work', 'urgent'], updatedAt: day(-3) },
      { title: 'b', tags: ['work', 'home'], updatedAt: day(-2) },
      { title: 'c', tags: [], updatedAt: day(-1) },
    ]);
    expect(await getAllTags()).toEqual(['home', 'urgent', 'work']);
  });

  it('getAllCategories returns a sorted, de-duplicated category list', async () => {
    await seedNotes([
      { title: 'a', category: 'Work', updatedAt: day(-3) },
      { title: 'b', category: 'Home', updatedAt: day(-2) },
      { title: 'c', category: 'Work', updatedAt: day(-1) },
    ]);
    expect(await getAllCategories()).toEqual(['Home', 'Work']);
  });
});

// ─── fileToDataUrl ───────────────────────────────────────────────────────────

describe('fileToDataUrl', () => {
  it('exposes MAX_INLINE_SIZE as 2 MiB', () => {
    expect(MAX_INLINE_SIZE).toBe(2 * 1024 * 1024);
  });

  it('converts a small file to a base64 data URL', async () => {
    const file = new File(['hello'], 'x.txt', { type: 'text/plain' });
    await expect(fileToDataUrl(file)).resolves.toBe('data:text/plain;base64,aGVsbG8=');
  });

  it('rejects when the underlying read errors', async () => {
    class FailingFileReader {
      public result: string | null = null;
      public onload: (() => void) | null = null;
      public onerror: ((event: unknown) => void) | null = null;

      public readAsDataURL(_blob: Blob): void {
        queueMicrotask(() => {
          this.onerror?.(new Error('simulated read failure'));
        });
      }
    }
    vi.stubGlobal('FileReader', FailingFileReader);
    try {
      const file = new File(['hello'], 'x.txt', { type: 'text/plain' });
      await expect(fileToDataUrl(file)).rejects.toThrow('simulated read failure');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});