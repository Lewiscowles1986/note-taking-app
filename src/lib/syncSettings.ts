/**
 * Sync configuration persistence.
 *
 * Sync settings are a tiny config blob (server URL, token, toggles) plus the
 * deletion tombstones needed for two-way sync — a poor fit for the relational
 * notes schema, so both live in localStorage. Keeping them OUT of IndexedDB
 * also means the database schema (and its e2e-pinned version) never changes.
 *
 * Tombstones: when a note is deleted we remember `{ uid, deletedAt, updatedAt }`
 * so the next sync can propagate the deletion to the server (and refrain from
 * pulling a stale remote copy back). Entries are pruned after 90 days — by
 * then any device that ever synced has either seen the deletion or would
 * resurrect a long-dead note anyway.
 */

const SETTINGS_KEY = 'notehaven.sync.settings';
const TOMBSTONES_KEY = 'notehaven.sync.tombstones';

/** Tombstones older than this are pruned on load (ms ≈ 90 days). */
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Tombstone cap — oldest entries are dropped first. */
export const MAX_TOMBSTONES = 500;

export interface SyncSettings {
  /** Base URL of the sync server, e.g. "https://sync.example.com" (no trailing slash). */
  serverUrl: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. Empty = unauthenticated. */
  authToken: string;
  /** Run a background sync every `intervalMinutes` while the app is open. */
  autoSync: boolean;
  intervalMinutes: number;
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
  lastSync: null,
};

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
      lastSync,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the editable fields + lastSync. Normalizes the server URL. */
export function saveSyncSettings(settings: SyncSettings & { lastSync?: LastSyncInfo | null }): void {
  const stored: StoredSyncSettings = {
    serverUrl: normalizeServerUrl(settings.serverUrl),
    authToken: settings.authToken,
    autoSync: settings.autoSync === true,
    intervalMinutes: isFinitePositive(settings.intervalMinutes)
      ? Math.max(1, Math.round(settings.intervalMinutes))
      : DEFAULT_SETTINGS.intervalMinutes,
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

// ─── tombstones ──────────────────────────────────────────────────────────────

export function loadTombstones(): Tombstone[] {
  try {
    const raw = localStorage.getItem(TOMBSTONES_KEY);
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

/** Remember a note deletion so the next sync can propagate it. */
export function recordTombstone(uid: string, deletedAt: Date, noteUpdatedAt: Date): void {
  const tombstones = loadTombstones().filter((t) => t.uid !== uid);
  tombstones.push({
    uid,
    deletedAt: deletedAt.toISOString(),
    noteUpdatedAt: noteUpdatedAt.toISOString(),
  });
  // Keep the newest MAX_TOMBSTONES.
  const trimmed = tombstones.slice(-MAX_TOMBSTONES);
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(trimmed));
}

/**
 * Keep only tombstones whose uid is in `keepUids` — the engine's way to drop
 * tombstones whose delete-remote operation has been acknowledged by the
 * server. Persisting an empty list clears the key entirely.
 */
export function retainTombstones(keepUids: Set<string>): void {
  const kept = loadTombstones().filter((t) => keepUids.has(t.uid));
  if (kept.length) {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(kept));
  } else {
    localStorage.removeItem(TOMBSTONES_KEY);
  }
}