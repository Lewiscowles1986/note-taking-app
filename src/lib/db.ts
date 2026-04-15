import Dexie, { type Table } from 'dexie';
import type { EncryptedPayload, StoredKeyPair } from './crypto';

export interface NoteAttachment {
  id: string;
  name: string;
  type: string;
  /** For small files, stored as base64 data URL. For large files, an external URL. */
  data: string;
  size: number;
  /** Resized thumbnail data URL for image attachments */
  thumbnail?: string;
}

export interface NoteRevision {
  id?: number;
  noteId: number;
  title: string;
  content: string;
  tags: string[];
  category: string;
  savedAt: Date;
}

export interface Note {
  id?: number;
  title: string;
  /** When encrypted, content holds JSON-serialised EncryptedPayload */
  content: string;
  tags: string[];
  category: string;
  attachments: NoteAttachment[];
  createdAt: Date;
  updatedAt: Date;
  /** Dates (ISO date strings YYYY-MM-DD) on which this note was edited */
  editDates: string[];
  pinned: boolean;
  /** Fast-detect flags for lazy-loading heavy renderers */
  hasCodeBlocks?: boolean;
  hasMermaid?: boolean;
  /** Encryption metadata — if set, content is encrypted */
  encrypted?: EncryptedPayload | null;
}

/** Detect content features for lazy-loading decisions */
export function detectContentFeatures(content: string) {
  return {
    hasCodeBlocks: /```(?!mermaid)[a-zA-Z]*\n[\s\S]*?```/.test(content),
    hasMermaid: /```mermaid\n[\s\S]*?```/.test(content),
  };
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

class NotesDatabase extends Dexie {
  notes!: Table<Note>;
  revisions!: Table<NoteRevision>;
  keyPairs!: Table<StoredKeyPair>;

  constructor() {
    super('NotesApp');
    this.version(1).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned',
    });
    this.version(2).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned',
    }).upgrade((tx) => {
      return tx.table('notes').toCollection().modify((note) => {
        const features = detectContentFeatures(note.content);
        note.hasCodeBlocks = features.hasCodeBlocks;
        note.hasMermaid = features.hasMermaid;
      });
    });
    this.version(3).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned, *editDates',
      revisions: '++id, noteId, savedAt',
    }).upgrade((tx) => {
      return tx.table('notes').toCollection().modify((note) => {
        const dates = new Set<string>();
        if (note.createdAt) dates.add(toDateKey(new Date(note.createdAt)));
        if (note.updatedAt) dates.add(toDateKey(new Date(note.updatedAt)));
        note.editDates = Array.from(dates);
      });
    });
    this.version(4).stores({
      notes: '++id, title, category, *tags, createdAt, updatedAt, pinned, *editDates',
      revisions: '++id, noteId, savedAt',
      keyPairs: 'id, fingerprint',
    });
  }
}

export const db = new NotesDatabase();

// ─── Key pair CRUD ──────────────────────────────────────────────

export async function saveKeyPair(kp: StoredKeyPair): Promise<void> {
  await db.keyPairs.put(kp);
}

export async function getAllKeyPairs(): Promise<StoredKeyPair[]> {
  return db.keyPairs.toArray();
}

export async function getKeyPairByFingerprint(fp: string): Promise<StoredKeyPair | undefined> {
  return db.keyPairs.where('fingerprint').equals(fp).first();
}

export async function deleteKeyPair(id: string): Promise<void> {
  await db.keyPairs.delete(id);
}

// ─── Note CRUD ──────────────────────────────────────────────────

export async function createNote(partial?: Partial<Note>): Promise<number> {
  const now = new Date();
  const dateKey = toDateKey(now);
  return db.notes.add({
    title: 'Untitled',
    content: '',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: now,
    updatedAt: now,
    editDates: [dateKey],
    pinned: false,
    encrypted: null,
    ...partial,
  });
}

export async function updateNote(id: number, changes: Partial<Note>) {
  const now = new Date();
  const dateKey = toDateKey(now);

  const existing = await db.notes.get(id);
  if (!existing) return;

  // Store a revision snapshot
  await db.revisions.add({
    noteId: id,
    title: existing.title,
    content: existing.content,
    tags: [...existing.tags],
    category: existing.category,
    savedAt: now,
  });

  const editDates = new Set(existing.editDates || []);
  editDates.add(dateKey);

  return db.notes.update(id, {
    ...changes,
    updatedAt: now,
    editDates: Array.from(editDates),
  });
}

export async function deleteNote(id: number) {
  await db.revisions.where('noteId').equals(id).delete();
  return db.notes.delete(id);
}

export async function getRevisions(noteId: number): Promise<NoteRevision[]> {
  return db.revisions.where('noteId').equals(noteId).reverse().sortBy('savedAt');
}

export async function getAllNotes(): Promise<Note[]> {
  return db.notes.orderBy('updatedAt').reverse().toArray();
}

export async function searchNotes(query: string): Promise<Note[]> {
  const q = query.toLowerCase();
  const all = await getAllNotes();
  return all.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
  );
}

export async function getNotesByTag(tag: string): Promise<Note[]> {
  return db.notes.where('tags').equals(tag).reverse().sortBy('updatedAt');
}

export async function getNotesByCategory(category: string): Promise<Note[]> {
  return db.notes.where('category').equals(category).reverse().sortBy('updatedAt');
}

export async function getAllTags(): Promise<string[]> {
  const all = await db.notes.toArray();
  const tagSet = new Set<string>();
  all.forEach((n) => n.tags.forEach((t) => tagSet.add(t)));
  return Array.from(tagSet).sort();
}

export async function getAllCategories(): Promise<string[]> {
  const all = await db.notes.toArray();
  const catSet = new Set<string>();
  all.forEach((n) => catSet.add(n.category));
  return Array.from(catSet).sort();
}

/** Max inline file size: 2MB. Larger files need a URL. */
export const MAX_INLINE_SIZE = 2 * 1024 * 1024;

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
