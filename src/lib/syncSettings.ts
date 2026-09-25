/**
 * Sync configuration persistence.
 *
 * Sync settings are a tiny config blob (server URL, token, toggles) plus the
 * deletion tombstones needed for two-way sync — a poor fit for the relational
 * notes schema, so both live in localStorage. Keeping them OUT of IndexedDB
 * also means the database schema (and its e2e-pinned version) never changes.
 *
 * MULTI-SERVER: the single-server blob here is the LEGACY layout, kept
 * importable (default fallback + migration source) — but the live layout is
 * per-server, owned by syncServers.ts (`notehaven.sync.server.<id>` et al).
 * New code should use getServerSettings/saveServerSettings (syncServers.ts)
 * and the `*For(serverId)` tombstone helpers below. The legacy accessors
 * remain for the migration path and the legacy-key unit tests.
 *
 * Tombstones: when a note is deleted we remember `{ uid, deletedAt, updatedAt }`
 * so the next sync can propagate the deletion to the server (and refrain from
 * pulling a stale remote copy back). Entries are pruned after 90 days — by
 * then any device that ever synced has either seen the deletion or would
 * resurrect a long-dead note anyway.
 */

const SETTINGS_KEY = 'notehaven.sync.settings';
const TOMBSTONES_KEY = 'notehaven.sync.tombstones';

// Per-server settings read/write come from syncServers.ts (the owner of the
// per-server layout). Imported here so recordSyncResultFor can merge into the
// server's CURRENT stored settings without a circular import (syncServers
// imports loadSyncSettings from this module — a runtime cycle via ESM
// function hoisting is safe, but keep it lazy to be robust in any bundler).
import { getServerSettings, saveServerSettings } from './syncServers';

/** Tombstones older than this are pruned on load (ms ≈ 90 days). */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Tombstone cap — oldest entries are dropped first. */
export const MAX_TOMBSTONES = 500;

export type SyncScope = 'all' | 'categories';

export interface SyncSettings {
  /** Base URL of the sync server, e.g. "https://sync.example.com" (no trailing slash). */
  serverUrl: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. Empty = unauthenticated. */
  authToken: string;
  /** Run a background sync every `intervalMinutes` while the app is open. */
  autoSync: boolean;
  intervalMinutes: number;
  /** What to sync: every note, or only the categories in `syncedCategories`. */
  syncScope: SyncScope;
  /** Chosen categories — used (and only used) when syncScope === 'categories'. */
  syncedCategories: string[];
  /** Client-side deny list: these categories never sync from this device. */
  excludedCategories: string[];
  /** Client-side deny list: these local note ids never sync from this device. */
  excludedNoteIds: number[];
}

export interface LastSyncInfo {
  at: string;
  ok: boolean;
  summary: string;
}

/** Settings as stored, including the outcome of the previous sync. */
export interface StoredSyncSettings extends SyncSettings {
  lastSync: LastSyncInfo | null;
}

export interface Tombstone {
  /** Sync identity of the deleted note. */
  uid: string;
  /** When the deletion happened (used to order against remote edits). */
  deletedAt: string;
  /** The note's updatedAt at deletion time — tombstone wins over remote copies older than this. */
  noteUpdatedAt: string;
}

const DEFAULT_SETTINGS: StoredSyncSettings = {
  serverUrl: '',
  authToken: '',
  autoSync: false,
  intervalMinutes: 15,
  syncScope: 'all',
  syncedCategories: [],
  excludedCategories: [],
  excludedNoteIds: [],
  lastSync: null,
};

/** Validate a category list: strings only, deduped. */
function toCategoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

/** Validate a note-id list: finite numbers only, deduped. */
function toNoteIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))));
}

function toScope(value: unknown): SyncScope {
  return value === 'categories' ? 'categories' : 'all';
}

/** Strip trailing slashes so URL joins never produce "//api/...". */
export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Read settings, tolerating corrupt/partial storage (falls back field-by-field). */
export function loadSyncSettings(): StoredSyncSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const lastSyncRaw = obj.lastSync;
    const lastSync: LastSyncInfo | null =
      lastSyncRaw &&
      typeof lastSyncRaw === 'object' &&
      typeof (lastSyncRaw as LastSyncInfo).at === 'string' &&
      typeof (lastSyncRaw as LastSyncInfo).summary === 'string'
        ? {
            at: (lastSyncRaw as LastSyncInfo).at,
            ok: !!(lastSyncRaw as LastSyncInfo).ok,
            summary: (lastSyncRaw as LastSyncInfo).summary,
          }
        : null;
    return {
      serverUrl: typeof obj.serverUrl === 'string' ? normalizeServerUrl(obj.serverUrl) : '',
      authToken: typeof obj.authToken === 'string' ? obj.authToken : '',
      autoSync: obj.autoSync === true,
      intervalMinutes: isFinitePositive(obj.intervalMinutes)
        ? Math.max(1, Math.round(obj.intervalMinutes))
        : DEFAULT_SETTINGS.intervalMinutes,
      syncScope: toScope(obj.syncScope),
      syncedCategories: toCategoryList(obj.syncedCategories),
      excludedCategories: toCategoryList(obj.excludedCategories),
      excludedNoteIds: toNoteIdList(obj.excludedNoteIds),
      lastSync,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the editable fields + lastSync. Normalizes the server URL. */
export function saveSyncSettings(
  settings: Omit<SyncSettings, 'syncScope' | 'syncedCategories' | 'excludedCategories' | 'excludedNoteIds'> & {
    lastSync?: LastSyncInfo | null;
    syncScope?: SyncScope;
    syncedCategories?: string[];
    excludedCategories?: string[];
    excludedNoteIds?: number[];
  },
): void {
  const stored: StoredSyncSettings = {
    serverUrl: normalizeServerUrl(settings.serverUrl),
    authToken: settings.authToken,
    autoSync: settings.autoSync === true,
    intervalMinutes: isFinitePositive(settings.intervalMinutes)
      ? Math.max(1, Math.round(settings.intervalMinutes))
      : DEFAULT_SETTINGS.intervalMinutes,
    syncScope: toScope(settings.syncScope),
    syncedCategories: toCategoryList(settings.syncedCategories),
    excludedCategories: toCategoryList(settings.excludedCategories),
    excludedNoteIds: toNoteIdList(settings.excludedNoteIds),
    lastSync: settings.lastSync ?? null,
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
}

/** Wipe configuration AND deletion history (the settings page's "forget server" action). */
export function clearSyncSettings(): void {
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(TOMBSTONES_KEY);
}

/**
 * Record the outcome of a sync run, merging into the CURRENTLY stored settings
 * (load-fresh-then-save) so a background auto-sync never clobbers edits the
 * user made to the config while a sync was running.
 */
export function recordSyncResult(info: LastSyncInfo): void {
  const current = loadSyncSettings();
  saveSyncSettings({ ...current, lastSync: info });
}

/**
 * True when a note's category qualifies for syncing under the stored scope:
 * scope 'all' syncs everything; scope 'categories' requires membership in
 * `syncedCategories` (an empty selection syncs nothing).
 */
export function isCategoryInScope(
  category: string,
  scope: SyncScope,
  syncedCategories: string[],
): boolean {
  if (scope !== 'categories') return true;
  return syncedCategories.includes(category);
}

/** True when the note id is on the device's deny list. */
export function isNoteExcluded(noteId: number, excludedNoteIds: number[]): boolean {
  return excludedNoteIds.includes(noteId);
}

// ─── the exclusion precedence model ──────────────────────────────────────────

export type SyncDecisionReason = 'server-denied' | 'client-denied' | 'out-of-scope' | 'allowed';
export type SyncDecision = 'sync' | 'skip';

export interface SyncDecisionInput {
  /** Layer 1 (server policy): categories the sync server refuses to store. */
  serverExcludedCategories: string[];
  /** Layer 1 (server policy): note uids the sync server refuses to store. */
  serverExcludedUids: string[];
  /** Sync identity (uid) of the note being decided — may be unknown (''). */
  uid: string;
  /** Local note id — may be unknown (-1) for remote-only notes. */
  noteId: number;
  /** The note's category. */
  category: string;
  /** Layer 2 (client allow): the configured sync scope. */
  syncScope: SyncScope;
  /** Layer 2 (client allow): chosen categories when scope === 'categories'. */
  syncedCategories: string[];
  /** Layer 2 (client deny): categories excluded on this device. */
  excludedCategories: string[];
  /** Layer 2 (client deny): local note ids excluded on this device. */
  excludedNoteIds: number[];
}

/**
 * The ONE decision function for "does this note sync?" — the single source of
 * truth used by the sync engine and rendered by the settings UI.
 *
 * PRECEDENCE TABLE (deny always wins):
 *
 *   | server deny | client allow (scope) | client deny | result   |
 *   |-------------|-----------------------|-------------|----------|
 *   | yes         | —                     | —           | EXCLUDED |
 *   | no          | no                    | —           | EXCLUDED |
 *   | no          | yes                   | no          | ALLOWED  |
 *   | no          | yes                   | yes         | EXCLUDED |
 *
 * Evaluated fail-closed: the first deny reason wins; a note only syncs when
 * every layer says yes. A server deny short-circuits before the client's
 * allow/deny layers are even consulted — the server is authoritative.
 */
export function resolveSyncDecision(input: SyncDecisionInput): {
  decision: SyncDecision;
  reason: SyncDecisionReason;
} {
  // Layer 1 — server policy. Checked first: it wins over everything else.
  if (input.serverExcludedUids.includes(input.uid) && input.uid !== '') {
    return { decision: 'skip', reason: 'server-denied' };
  }
  if (input.serverExcludedCategories.includes(input.category)) {
    return { decision: 'skip', reason: 'server-denied' };
  }
  // Layer 2 — the device's own deny lists. Client deny beats client allow.
  if (input.excludedNoteIds.includes(input.noteId)) {
    return { decision: 'skip', reason: 'client-denied' };
  }
  if (input.excludedCategories.includes(input.category)) {
    return { decision: 'skip', reason: 'client-denied' };
  }
  // Layer 2 — the allow list. Only reached when nothing denied the note.
  if (!isCategoryInScope(input.category, input.syncScope, input.syncedCategories)) {
    return { decision: 'skip', reason: 'out-of-scope' };
  }
  return { decision: 'sync', reason: 'allowed' };
}

// ─── tombstones ──────────────────────────────────────────────────────────────

// Per-server tombstone keys (multi-server sync): the engine and
// syncDeletion.ts address a server's list by its id (the normalized URL).
// See syncServers.ts for the full per-server key layout.

export function tombstonesKeyFor(serverId: string): string {
  return `notehaven.sync.tombstones.${serverId}`;
}

/** Read ONE server's tombstone list (TTL + cap applied on load). */
export function loadTombstonesFor(serverId: string): Tombstone[] {
  return readTombstones(tombstonesKeyFor(serverId));
}

/** Remember a note deletion for ONE server so the next sync can propagate it. */
export function recordTombstoneFor(serverId: string, uid: string, deletedAt: Date, noteUpdatedAt: Date): void {
  writeTombstones(tombstonesKeyFor(serverId), [
    ...loadTombstonesFor(serverId).filter((t) => t.uid !== uid),
    {
      uid,
      deletedAt: deletedAt.toISOString(),
      noteUpdatedAt: noteUpdatedAt.toISOString(),
    },
  ]);
}

/** Keep only tombstones whose uid is in `keepUids` — for ONE server. */
export function retainTombstonesFor(serverId: string, keepUids: Set<string>): void {
  const kept = loadTombstonesFor(serverId).filter((t) => keepUids.has(t.uid));
  const key = tombstonesKeyFor(serverId);
  if (kept.length) {
    localStorage.setItem(key, JSON.stringify(kept));
  } else {
    localStorage.removeItem(key);
  }
}

/**
 * Record the outcome of a sync run against ONE server, merging into THAT
 * server's stored settings (load-fresh-then-save) so a background auto-sync
 * never clobbers edits the user made to the config while a sync was running.
 */
export function recordSyncResultFor(serverId: string, info: LastSyncInfo): void {
  // Read fresh per-server settings, reattach serverUrl, merge lastSync.
  const current = getServerSettings(serverId);
  saveServerSettings(serverId, { ...current, lastSync: info });
}

/** Shared tombstone reader (TTL prune, sort, cap) for any storage key. */
function readTombstones(key: string): Tombstone[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    return parsed
      .filter(
        (t): t is Tombstone =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as Tombstone).uid === 'string' &&
          typeof (t as Tombstone).deletedAt === 'string',
      )
      .filter((t) => Date.parse(t.deletedAt) > cutoff)
      .sort((a, b) => a.deletedAt.localeCompare(b.deletedAt))
      .slice(-MAX_TOMBSTONES);
  } catch {
    return [];
  }
}

/** Shared tombstone writer (same-uid replace + cap) for any storage key. */
function writeTombstones(key: string, tombstones: Tombstone[]): void {
  localStorage.setItem(key, JSON.stringify(tombstones.slice(-MAX_TOMBSTONES)));
}

export function loadTombstones(): Tombstone[] {
  return readTombstones(TOMBSTONES_KEY);
}

/** Remember a note deletion so the next sync can propagate it (legacy key). */
export function recordTombstone(uid: string, deletedAt: Date, noteUpdatedAt: Date): void {
  writeTombstones(TOMBSTONES_KEY, [
    ...loadTombstones().filter((t) => t.uid !== uid),
    {
      uid,
      deletedAt: deletedAt.toISOString(),
      noteUpdatedAt: noteUpdatedAt.toISOString(),
    },
  ]);
}

/**
 * Keep only tombstones whose uid is in `keepUids` — the engine's way to drop
 * tombstones whose delete-remote operation has been acknowledged by the
 * server. Persisting an empty list clears the key entirely. (Legacy key;
 * engine code uses retainTombstonesFor.)
 */
export function retainTombstones(keepUids: Set<string>): void {
  const kept = loadTombstones().filter((t) => keepUids.has(t.uid));
  if (kept.length) {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(kept));
  } else {
    localStorage.removeItem(TOMBSTONES_KEY);
  }
}