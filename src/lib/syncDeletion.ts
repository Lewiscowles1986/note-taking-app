/**
 * Deletion hook — the ONLY piece of sync the note-deletion path needs.
 *
 * Kept dependency-free and tiny so it can be imported eagerly (via
 * `useNotes`) without pulling the sync engine's network/planner code into
 * the entry chunk: a user who never configures a server still gets correct
 * tombstone bookkeeping (so their deletions propagate IF they later sync),
 * at a cost of a few hundred bytes instead of the whole engine.
 *
 * Storage keys mirror the engine's (sync.ts). Kept in sync by convention —
 * see docs/sync.md, "Storage layout on the client".
 */

const UID_MAP_KEY = 'notehaven.sync.uidMap';
const TOMBSTONES_KEY = 'notehaven.sync.tombstones';

interface RawUidMap {
  [noteId: string]: string;
}

function loadUidMap(): RawUidMap {
  try {
    const raw = localStorage.getItem(UID_MAP_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: RawUidMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

export interface DeletionInfo {
  uid: string;
  deletedAt: string;
  noteUpdatedAt: string;
}

/**
 * Pure helper: compute the tombstone list that records `deletion`. Returns a
 * plain array for the caller to persist — split out so the merge logic is
 * unit-testable without touching storage.
 */
export function withTombstone(
  tombstones: DeletionInfo[],
  deletion: DeletionInfo,
  maxTombstones = 500,
): DeletionInfo[] {
  const next = [...tombstones.filter((t) => t.uid !== deletion.uid), deletion];
  return next.slice(-maxTombstones);
}

/** Read the stored tombstone list defensively; [] when absent or corrupt. */
export function loadRawTombstones(): DeletionInfo[] {
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is DeletionInfo =>
        !!t &&
        typeof t === 'object' &&
        typeof (t as DeletionInfo).uid === 'string' &&
        typeof (t as DeletionInfo).deletedAt === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Record a note deletion for the next sync, synchronously, with no imports
 * from the sync engine. Safe for never-synced notes (no uid → nothing to do
 * beyond forgetting any mapping).
 *
 * NOTE: intentionally does NOT enforce the 90-day tombstone TTL here —
 * pruning is the engine's job on load, and this module must not encode
 * policy the engine owns.
 */
export function recordDeletion(noteId: number, noteUpdatedAt: Date): void {
  try {
    const uidMap = loadUidMap();
    const key = String(noteId);
    const uid = uidMap[key];
    if (uid) {
      const next = withTombstone(loadRawTombstones(), {
        uid,
        deletedAt: new Date().toISOString(),
        noteUpdatedAt: noteUpdatedAt.toISOString(),
      });
      localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(next));
      delete uidMap[key];
      localStorage.setItem(UID_MAP_KEY, JSON.stringify(uidMap));
    } else {
      // Never synced: drop any stale mapping defensively (no tombstone —
      // the server never had the note, so there is nothing to propagate).
      delete uidMap[key];
      localStorage.setItem(UID_MAP_KEY, JSON.stringify(uidMap));
    }
  } catch {
    // Storage unavailable/unwritable — deletion proceeds regardless; the
    // engine reconciles against the server manifest on the next sync.
  }
}