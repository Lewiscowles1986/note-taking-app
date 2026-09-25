/**
 * Sync notification queue — the never-delete policy's user-facing half.
 *
 * The sync engine NEVER removes local notes because the server says so. When
 * it detects a genuine server-side deletion of an in-scope note, it enqueues
 * an entry here instead. A bell in the app header (SyncNotifications.tsx)
 * shows the pending count and lets the user decide per note:
 *
 *   - KEEP  → the uid joins the per-client permanent exception set: never
 *             re-prompted, never delete-local'd on this browser profile. The
 *             local note (if any) is untouched; a later remote resurrection
 *             still pulls normally.
 *   - DELETE → the local note is removed at the user's explicit command with
 *             the same tombstone bookkeeping as a user deletion.
 *
 * Storage (localStorage — per browser profile, i.e. per client/device; each
 * configured sync server keeps its OWN queue and exceptions, keyed by the
 * server id — the normalized URL):
 *   notehaven.sync.notifications.<serverId>  → queue of pending prompts
 *   notehaven.sync.keepExceptions.<serverId> → uid → ISO timestamp the user
 *                                              chose Keep for that server
 *
 * Dependency-free: imported eagerly by the header component, so it must not
 * pull in the sync engine.
 */

/** Queue key for one server (server id = normalized URL). */
const queueKeyFor = (serverId: string): string => `notehaven.sync.notifications.${serverId}`;
/** Keep-exceptions key for one server. */
const exceptionsKeyFor = (serverId: string): string => `notehaven.sync.keepExceptions.${serverId}`;

import { listServerIds } from './syncServers';

export type SyncNotificationKind = 'remote-delete';

export interface SyncNotification {
  /** Stable id: `${serverId}:${kind}:${uid}` — dedupes re-enqueues of the
   * same uid on the same server while keeping servers independent. */
  id: string;
  /** Sync server this prompt belongs to (normalized URL). */
  serverId: string;
  /** Sync uid of the deleted remote note (ON THAT SERVER). */
  uid: string;
  /** Best-known title (from the local copy or the last synced payload). */
  title: string;
  category: string;
  /** When the server says the note was deleted (manifest updatedAt). */
  deletedAt: string;
  /** When this client noticed (queued). */
  queuedAt: string;
  kind: SyncNotificationKind;
}

function loadJson<T>(key: string, validate: (v: unknown) => T | null): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed);
  } catch {
    return null;
  }
}

function isValidNotification(v: unknown): v is SyncNotification {
  if (!v || typeof v !== 'object') return false;
  const n = v as Partial<SyncNotification>;
  return (
    typeof n.id === 'string' && n.id.length > 0 &&
    typeof n.uid === 'string' && n.uid.length > 0 &&
    typeof n.title === 'string' &&
    typeof n.category === 'string' &&
    typeof n.deletedAt === 'string' &&
    typeof n.queuedAt === 'string' &&
    (n.serverId === undefined || typeof n.serverId === 'string')
  );
}

/** Event fired whenever the queue or exceptions change (same-tab reactivity). */
export const SYNC_NOTIFICATIONS_EVENT = 'notehaven:sync-notifications';

function notifyChange(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(SYNC_NOTIFICATIONS_EVENT));
  }
}

/** Pending prompts for ONE server, oldest first. */
export function getPendingNotifications(serverId: string): SyncNotification[] {
  const list = loadJson(queueKeyFor(serverId), (v) => (Array.isArray(v) ? (v as unknown[]) : null));
  if (!list) return [];
  return list.filter(isValidNotification);
}

/** ALL pending prompts across every configured server (bell count). */
export function getAllPendingNotifications(serverIds: string[]): SyncNotification[] {
  return serverIds.flatMap((id) => getPendingNotifications(id));
}

function saveQueue(serverId: string, entries: SyncNotification[]): void {
  if (entries.length) {
    localStorage.setItem(queueKeyFor(serverId), JSON.stringify(entries));
  } else {
    localStorage.removeItem(queueKeyFor(serverId));
  }
}

/** A uid is already queued (any kind) on THIS server — engine must not double-enqueue. */
export function isQueued(serverId: string, uid: string): boolean {
  return getPendingNotifications(serverId).some((n) => n.uid === uid);
}

export interface RemoteDeletionInfo {
  /** Sync server the deletion happened on (normalized URL). */
  serverId: string;
  uid: string;
  title: string;
  category: string;
  /** Manifest updatedAt of the remote tombstone. */
  deletedAt: string;
  kind?: SyncNotificationKind;
}

/**
 * Queue a "note was deleted on the server" prompt. Skips silently when the
 * uid already has a pending entry or a Keep exception (re-prompt prevention
 * is enforced HERE so every caller gets it for free). Returns the entry, or
 * null when nothing was queued.
 */
export function enqueueRemoteDeletion(info: RemoteDeletionInfo): SyncNotification | null {
  if (!info.uid || !info.serverId) return null;
  if (hasKeepException(info.serverId, info.uid) || isQueued(info.serverId, info.uid)) return null;
  const kind = info.kind ?? 'remote-delete';
  const entry: SyncNotification = {
    id: `${info.serverId}:${kind}:${info.uid}`,
    serverId: info.serverId,
    uid: info.uid,
    title: info.title || 'Untitled',
    category: info.category || 'General',
    deletedAt: info.deletedAt,
    queuedAt: new Date().toISOString(),
    kind,
  };
  saveQueue(info.serverId, [...getPendingNotifications(info.serverId), entry]);
  notifyChange();
  return entry;
}

/**
 * Locate a queue entry by its stable id across ALL configured servers (the
 * id embeds the server id, but server URLs contain ':' too, so the lookup is
 * by scan — parsing the id would be ambiguous with the scheme separator).
 */
function findEntry(serverIds: string[], id: string): SyncNotification | undefined {
  for (const serverId of serverIds) {
    const found = getPendingNotifications(serverId).find((n) => n.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Drop an entry from its server's queue (after it has been resolved). */
export function removeNotification(id: string): void {
  for (const serverId of listServerIds()) {
    const remaining = getPendingNotifications(serverId).filter((n) => n.id !== id);
    if (remaining.length !== getPendingNotifications(serverId).length) {
      saveQueue(serverId, remaining);
      notifyChange();
      return;
    }
  }
}

export type NotificationDecision = 'keep' | 'delete';

/**
 * Resolve a queued prompt:
 *  - 'keep'   → permanent exception for this client + server + queue entry
 *               removed. The local note is untouched; the remote tombstone
 *               stays (the exception prevents any re-prompt), and a later
 *               remote resurrection still pulls normally.
 *  - 'delete' → the local note is removed at the user's explicit command via
 *               the sync engine's deleteNoteForUid (dynamically imported so
 *               the engine stays out of the eager chunk), that server's stale
 *               local tombstone for the uid is consumed, and the queue entry
 *               is removed. No new tombstone is recorded — the remote side is
 *               already tombstoned, so there is nothing to propagate.
 */
export async function resolveNotification(id: string, decision: NotificationDecision): Promise<void> {
  // Look the entry up across every configured server's queue (see findEntry:
  // the id embeds the server id, but URLs contain ':' so it is not parseable).
  const entry = findEntry(listServerIds(), id);
  if (!entry || !entry.serverId) return;
  const serverId = entry.serverId;
  if (decision === 'keep') {
    addKeepException(serverId, entry.uid);
    removeNotification(id);
    return;
  }
  // 'delete': drop stale local tombstone state for the uid first, then let
  // the engine remove the note + revisions + uid mapping.
  try {
    const { retainTombstonesFor, loadTombstonesFor } = await import('./syncSettings');
    const remaining = loadTombstonesFor(serverId).filter((t) => t.uid !== entry.uid);
    retainTombstonesFor(serverId, new Set(remaining.map((t) => t.uid)));
  } catch {
    /* storage hiccup — deletion proceeds regardless */
  }
  try {
    const { deleteNoteForUid } = await import('./sync');
    await deleteNoteForUid(serverId, entry.uid);
  } finally {
    removeNotification(id);
  }
}

// ─── per-client permanent exceptions (per server) ───────────────────────────

/** uid → ISO timestamp the user chose Keep (for one server). */
function loadExceptions(serverId: string): Record<string, string> {
  const obj = loadJson(exceptionsKeyFor(serverId), (v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null,
  );
  const out: Record<string, string> = {};
  for (const [uid, value] of Object.entries(obj ?? {})) {
    if (typeof value === 'string') out[uid] = value;
  }
  return out;
}

/** Has the user permanently chosen Keep for this uid on this client + server? */
export function hasKeepException(serverId: string, uid: string): boolean {
  return uid in loadExceptions(serverId);
}

/** Record the permanent Keep exception (never re-prompt, never delete-local). */
export function addKeepException(serverId: string, uid: string): void {
  if (!uid || !serverId) return;
  const exceptions = loadExceptions(serverId);
  exceptions[uid] = new Date().toISOString();
  localStorage.setItem(exceptionsKeyFor(serverId), JSON.stringify(exceptions));
  notifyChange();
}

/** All uids with a permanent Keep exception for ONE server (docs/tests/debug). */
export function getKeepExceptionUids(serverId: string): string[] {
  return Object.keys(loadExceptions(serverId)).sort();
}

/**
 * True when the uid would NOT be re-prompted right now (exception or already
 * pending on this server) — the engine's single check before enqueuing.
 */
export function wouldPromptBeSuppressed(serverId: string, uid: string): boolean {
  return hasKeepException(serverId, uid) || isQueued(serverId, uid);
}