/**
 * Multi-server sync configuration store.
 *
 * The single-server layout (`notehaven.sync.settings` + friends) generalizes
 * to one blob PER configured sync server. The normalized server URL IS the
 * server id: it is stable (same server → same id forever), human-readable
 * (visible in devtools), and needs no extra uuid to manage. Everything is
 * localStorage — the IndexedDB schema (and its e2e-pinned version) is never
 * touched for sync configuration.
 *
 * Storage layout (all localStorage):
 *
 *   notehaven.sync.servers                       → { servers: ServerRecord[] }
 *   notehaven.sync.server.<id>                   → per-server settings blob
 *   notehaven.sync.tombstones.<id>               → per-server tombstones
 *   notehaven.sync.uidMap.<id>                   → per-server noteId → uid map
 *   notehaven.sync.remoteCategories.<id>         → per-server uid → category
 *   notehaven.sync.notifications.<id>            → per-server prompt queue
 *   notehaven.sync.keepExceptions.<id>           → per-server Keep exceptions
 *   notehaven.sync.oidc.<id>                     → per-server OIDC config+session
 *   notehaven.sync.excludedNotes                 → DEVICE-WIDE note deny list
 *
 * `excludedNoteIds` stays device-wide (moved out of the per-server settings):
 * a note exclusion is a statement about the NOTE on this device, not about a
 * server. It is migrated out of the legacy settings blob once.
 *
 * Legacy keys (`notehaven.sync.settings`, `…tombstones`, …) are READ exactly
 * once by `migrateIfNeeded` and then never written again. They are NOT
 * deleted: a migration bug must never destroy the user's only copy of their
 * config (the stale keys are harmless — nothing reads them after migration).
 *
 * Dependency-free on purpose: imported eagerly (via syncDeletion → useNotes),
 * so it must not pull in the sync engine or the OIDC machinery.
 */

import {
  loadSyncSettings,
  type StoredSyncSettings,
  normalizeServerUrl,
} from './syncSettings';

/** The list-of-servers blob. */
const SERVERS_KEY = 'notehaven.sync.servers';
/** Migration done-marker: written once, makes migration idempotent. */
const MIGRATED_KEY = 'notehaven.sync.servers.migrated';
/** Device-wide excluded note ids (moved out of the per-server settings). */
export const EXCLUDED_NOTES_KEY = 'notehaven.sync.excludedNotes';

/** A configured sync server. The normalized URL is the identity. */
export interface ServerRecord {
  /** normalizeServerUrl(url) — the stable identity used in every per-server key. */
  id: string;
  /** Optional display name; falls back to the URL (host+port) in the UI. */
  label?: string;
  /** ISO date the server was added. */
  addedAt: string;
}

interface ServersBlob {
  servers?: unknown;
}

/** The full per-server settings shape = the legacy blob minus `serverUrl`. */
export type ServerSettings = Omit<StoredSyncSettings, 'serverUrl'>;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  authToken: '',
  autoSync: false,
  intervalMinutes: 15,
  syncScope: 'all',
  syncedCategories: [],
  excludedCategories: [],
  excludedNoteIds: [],
  lastSync: null,
};

// ─── tiny key helpers (the <id> suffix pattern) ──────────────────────────────

/** Settings blob for one server. */
const settingsKey = (id: string): string => `notehaven.sync.server.${id}`;
/** Tombstones for one server. */
export const tombstonesKey = (id: string): string => `notehaven.sync.tombstones.${id}`;
/** uidMap for one server. */
export const uidMapKey = (id: string): string => `notehaven.sync.uidMap.${id}`;
/** remoteCategories for one server. */
export const remoteCategoriesKey = (id: string): string => `notehaven.sync.remoteCategories.${id}`;
/** notification queue for one server. */
export const notificationsKey = (id: string): string => `notehaven.sync.notifications.${id}`;
/** Keep exceptions for one server. */
export const keepExceptionsKey = (id: string): string => `notehaven.sync.keepExceptions.${id}`;
/** OIDC blob (config+session) for one server. */
export const oidcKey = (id: string): string => `notehaven.sync.oidc.${id}`;

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// ─── server list ─────────────────────────────────────────────────────────────

function readServers(): ServerRecord[] {
  const parsed = safeParse(localStorage.getItem(SERVERS_KEY));
  const list = (parsed as ServersBlob | null)?.servers;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ServerRecord[] = [];
  for (const entry of list) {
    const record = entry as Partial<ServerRecord>;
    if (!record || typeof record.id !== 'string' || !record.id) continue;
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    out.push({
      id: record.id,
      label: typeof record.label === 'string' && record.label ? record.label : undefined,
      addedAt: typeof record.addedAt === 'string' ? record.addedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

function writeServers(servers: ServerRecord[]): void {
  if (servers.length) {
    localStorage.setItem(SERVERS_KEY, JSON.stringify({ servers }));
  } else {
    // An empty server list is a valid state (the user removed everything).
    localStorage.removeItem(SERVERS_KEY);
  }
}

/** Configured servers, oldest first. Triggers lazy migration. */
export function listServers(): ServerRecord[] {
  migrateIfNeeded();
  return readServers();
}

/** Server ids, oldest first. Convenience for engine loops. */
export function listServerIds(): string[] {
  return listServers().map((s) => s.id);
}

/**
 * Register a server. Idempotent: an already-configured URL returns the
 * existing record (no duplicate rows, label preserved).
 */
export function addServer(url: string, label?: string): ServerRecord {
  const id = normalizeServerUrl(url);
  if (!id) throw new Error('Server URL is required');
  migrateIfNeeded();
  const servers = readServers();
  const existing = servers.find((s) => s.id === id);
  if (existing) return existing;
  const record: ServerRecord = {
    id,
    label: label?.trim() || undefined,
    addedAt: new Date().toISOString(),
  };
  writeServers([...servers, record]);
  return record;
}

/** Remove a server and wipe EVERY per-server key for it. */
export function removeServer(id: string): void {
  migrateIfNeeded();
  writeServers(readServers().filter((s) => s.id !== id));
  clearServerData(id);
}

/** Set (or clear with '') the display label of a server. */
export function renameServer(id: string, label: string): void {
  migrateIfNeeded();
  const servers = readServers();
  const record = servers.find((s) => s.id === id);
  if (!record) return;
  const trimmed = label.trim();
  if (trimmed) record.label = trimmed;
  else delete record.label;
  writeServers(servers);
}

// ─── per-server settings ─────────────────────────────────────────────────────

/**
 * Read one server's settings. `serverUrl` is filled in for convenience (it
 * always equals the id) so existing settings-shaped consumers keep working.
 */
export function getServerSettings(id: string): StoredSyncSettings {
  migrateIfNeeded();
  const parsed = safeParse(localStorage.getItem(settingsKey(id)));
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const lastSyncRaw = obj.lastSync;
  const lastSync =
    lastSyncRaw &&
    typeof lastSyncRaw === 'object' &&
    typeof (lastSyncRaw as { at?: unknown }).at === 'string' &&
    typeof (lastSyncRaw as { summary?: unknown }).summary === 'string'
      ? {
          at: (lastSyncRaw as { at: string }).at,
          ok: !!(lastSyncRaw as { ok?: unknown }).ok,
          summary: (lastSyncRaw as { summary: string }).summary,
        }
      : null;
  const isPosInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0;
  const toList = (v: unknown): string[] =>
    Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))) : [];
  const toIds = (v: unknown): number[] =>
    Array.isArray(v) ? Array.from(new Set(v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)))) : [];
  return {
    serverUrl: id,
    authToken: typeof obj.authToken === 'string' ? obj.authToken : '',
    autoSync: obj.autoSync === true,
    intervalMinutes: isPosInt(obj.intervalMinutes) ? Math.max(1, Math.round(obj.intervalMinutes)) : 15,
    syncScope: obj.syncScope === 'categories' ? 'categories' : 'all',
    syncedCategories: toList(obj.syncedCategories),
    excludedCategories: toList(obj.excludedCategories),
    // Note exclusions are device-wide (EXCLUDED_NOTES_KEY), not per-server —
    // kept in the shape for compatibility with decision inputs.
    excludedNoteIds: loadExcludedNoteIds(),
    lastSync,
  };
}

/**
 * Persist one server's settings (the legacy saveSyncSettings shape; the
 * serverUrl field is ignored — the id IS the url).
 */
export function saveServerSettings(
  id: string,
  settings: Omit<StoredSyncSettings, 'serverUrl'> & { serverUrl?: string },
): void {
  const stored: StoredSyncSettings = {
    serverUrl: id,
    authToken: settings.authToken,
    autoSync: settings.autoSync === true,
    intervalMinutes:
      typeof settings.intervalMinutes === 'number' && Number.isFinite(settings.intervalMinutes) && settings.intervalMinutes > 0
        ? Math.max(1, Math.round(settings.intervalMinutes))
        : 15,
    syncScope: settings.syncScope === 'categories' ? 'categories' : 'all',
    syncedCategories: Array.isArray(settings.syncedCategories)
      ? Array.from(new Set(settings.syncedCategories.filter((c) => typeof c === 'string' && c)))
      : [],
    excludedCategories: Array.isArray(settings.excludedCategories)
      ? Array.from(new Set(settings.excludedCategories.filter((c) => typeof c === 'string' && c)))
      : [],
    excludedNoteIds: Array.isArray(settings.excludedNoteIds)
      ? Array.from(new Set(settings.excludedNoteIds.filter((n) => typeof n === 'number' && Number.isFinite(n))))
      : [],
    lastSync: settings.lastSync ?? null,
  };
  localStorage.setItem(settingsKey(id), JSON.stringify(stored));
}

/**
 * Wipe ALL data for one server (the per-server "Forget"): settings,
 * tombstones, uidMap, remoteCategories, notifications, keepExceptions, OIDC.
 */
export function clearServerData(id: string): void {
  localStorage.removeItem(settingsKey(id));
  localStorage.removeItem(tombstonesKey(id));
  localStorage.removeItem(uidMapKey(id));
  localStorage.removeItem(remoteCategoriesKey(id));
  localStorage.removeItem(notificationsKey(id));
  localStorage.removeItem(keepExceptionsKey(id));
  localStorage.removeItem(oidcKey(id));
}

// ─── device-wide note exclusions ─────────────────────────────────────────────

/** Excluded note ids for this DEVICE (all servers). */
export function loadExcludedNoteIds(): number[] {
  const parsed = safeParse(localStorage.getItem(EXCLUDED_NOTES_KEY));
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))));
}

/** Persist the device-wide excluded note ids. */
export function saveExcludedNoteIds(ids: number[]): void {
  localStorage.setItem(
    EXCLUDED_NOTES_KEY,
    JSON.stringify(Array.from(new Set(ids.filter((v) => typeof v === 'number' && Number.isFinite(v))))),
  );
}

// ─── migration (single-server → multi-server, lazy + idempotent) ─────────────

/**
 * One-time migration of the legacy single-server blobs into the first server
 * slot. Runs lazily on first access to any servers API, is guarded by a
 * done-marker key, and never deletes the legacy keys: a buggy migration must
 * not destroy the user's only copy of the configuration (the stale legacy
 * keys are simply never read again). If the legacy settings have no server
 * URL configured, there is nothing to migrate.
 */
export function migrateIfNeeded(): void {
  if (localStorage.getItem(MIGRATED_KEY)) return;
  try {
    const legacy = loadSyncSettings();
    if (legacy.serverUrl) {
      const id = normalizeServerUrl(legacy.serverUrl);
      // Only seed the server record when no list exists yet (a user who
      // already configured servers wins over the legacy blob).
      if (readServers().length === 0) {
        writeServers([{ id, addedAt: new Date(0).toISOString() }]);
        if (!localStorage.getItem(settingsKey(id))) {
          const { serverUrl: _ignored, ...rest } = legacy;
          saveServerSettings(id, rest);
        }
        // Copy every other legacy blob into per-server keys, without
        // overwriting anything already written per-server.
        copyLegacyBlob('notehaven.sync.tombstones', tombstonesKey(id));
        copyLegacyBlob('notehaven.sync.uidMap', uidMapKey(id));
        copyLegacyBlob('notehaven.sync.remoteCategories', remoteCategoriesKey(id));
        copyLegacyBlob('notehaven.sync.notifications', notificationsKey(id));
        copyLegacyBlob('notehaven.sync.keepExceptions', keepExceptionsKey(id));
        copyLegacyBlob('notehaven.sync.oidc', oidcKey(id));
      }
      // The device-wide note-exclusion list moves out of the settings blob.
      if (legacy.excludedNoteIds.length > 0 && loadExcludedNoteIds().length === 0) {
        saveExcludedNoteIds(legacy.excludedNoteIds);
      }
    }
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    // Storage trouble: retry on the next access rather than marking done —
    // the guard only flips when the migration actually completed.
  }
}

function copyLegacyBlob(legacyKey: string, perServerKey: string): void {
  if (localStorage.getItem(perServerKey)) return; // never clobber per-server state
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) localStorage.setItem(perServerKey, legacy);
}