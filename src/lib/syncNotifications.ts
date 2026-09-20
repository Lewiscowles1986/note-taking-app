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
 * Storage (localStorage — per browser profile, i.e. per client/device):
 *   notehaven.sync.notifications  → queue of pending prompts
 *   notehaven.sync.keepExceptions → uid → ISO timestamp the user chose Keep
 *
 * Dependency-free: imported eagerly by the header component, so it must not
 * pull in the sync engine.
 */

const QUEUE_KEY = 'notehaven.sync.notifications';
const EXCEPTIONS_KEY = 'notehaven.sync.keepExceptions';

export type SyncNotificationKind = 'remote-delete';

export interface SyncNotification {
  /** Stable id: `${kind}:${uid}` — dedupes re-enqueues of the same uid. */
  id: string;
  /** Sync uid of the deleted remote note. */
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
    typeof n.queuedAt === 'string'
  );
}

/** Event fired whenever the queue or exceptions change (same-tab reactivity). */
export const SYNC_NOTIFICATIONS_EVENT = 'notehaven:sync-notifications';

function notifyChange(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(SYNC_NOTIFICATIONS_EVENT));
  }
}

/** Pending prompts, oldest first. */
export function getPendingNotifications(): SyncNotification[] {
  const list = loadJson(QUEUE_KEY, (v) => (Array.isArray(v) ? (v as unknown[]) : null));
  if (!list) return [];
  return list.filter(isValidNotification);
}

function saveQueue(entries: SyncNotification[]): void {
  if (entries.length) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(entries));
  } else {
    localStorage.removeItem(QUEUE_KEY);
  }
}

/** A uid is already queued (any kind) — engine must not double-enqueue. */
export function isQueued(uid: string): boolean {
  return getPendingNotifications().some((n) => n.uid === uid);
}

export interface RemoteDeletionInfo {
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
  if (!info.uid) return null;
  if (hasKeepException(info.uid) || isQueued(info.uid)) return null;
  const kind = info.kind ?? 'remote-delete';
  const entry: SyncNotification = {
    id: `${kind}:${info.uid}`,
    uid: info.uid,
    title: info.title || 'Untitled',
    category: info.category || 'General',
    deletedAt: info.deletedAt,
    queuedAt: new Date().toISOString(),
    kind,
  };
  saveQueue([...getPendingNotifications(), entry]);
  notifyChange();
  return entry;
}

/** Drop an entry from the queue (after it has been resolved). */
export function removeNotification(id: string): void {
  saveQueue(getPendingNotifications().filter((n) => n.id !== id));
  notifyChange();
}

export type NotificationDecision = 'keep' | 'delete';

/**
 * Resolve a queued prompt:
 *  - 'keep'   → permanent exception for this client + queue entry removed.
 *               The local note is untouched; the remote tombstone stays (the
 *               exception prevents any re-prompt), and a later remote
 *               resurrection still pulls normally.
 *  - 'delete' → the local note is removed at the user's explicit command via
 *               the sync engine's deleteNoteForUid (dynamically imported so
 *               the engine stays out of the eager chunk), any stale local
 *               tombstone for the uid is consumed, and the queue entry is
 *               removed. No new tombstone is recorded — the remote side is
 *               already tombstoned, so there is nothing to propagate.
 */
export async function resolveNotification(id: string, decision: NotificationDecision): Promise<void> {
  const entry = getPendingNotifications().find((n) => n.id === id);
  if (!entry) return;
  if (decision === 'keep') {
    addKeepException(entry.uid);
    removeNotification(id);
    return;
  }
  // 'delete': drop stale local tombstone state for the uid first, then let
  // the engine remove the note + revisions + uid mapping.
  try {
    const { retainTombstones, loadTombstones } = await import('./syncSettings');
    const remaining = loadTombstones().filter((t) => t.uid !== entry.uid);
    retainTombstones(new Set(remaining.map((t) => t.uid)));
  } catch {
    /* storage hiccup — deletion proceeds regardless */
  }
  try {
    const { deleteNoteForUid } = await import('./sync');
    await deleteNoteForUid(entry.uid);
  } finally {
    removeNotification(id);
  }
}

// ─── per-client permanent exceptions ─────────────────────────────────────────

/** uid → ISO timestamp the user chose Keep. */
function loadExceptions(): Record<string, string> {
  const obj = loadJson(EXCEPTIONS_KEY, (v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null,
  );
  const out: Record<string, string> = {};
  for (const [uid, value] of Object.entries(obj ?? {})) {
    if (typeof value === 'string') out[uid] = value;
  }
  return out;
}

/** Has the user permanently chosen Keep for this uid on this client? */
export function hasKeepException(uid: string): boolean {
  return uid in loadExceptions();
}

/** Record the permanent Keep exception (never re-prompt, never delete-local). */
export function addKeepException(uid: string): void {
  if (!uid) return;
  const exceptions = loadExceptions();
  exceptions[uid] = new Date().toISOString();
  localStorage.setItem(EXCEPTIONS_KEY, JSON.stringify(exceptions));
  notifyChange();
}

/** All uids with a permanent Keep exception (for docs/tests/debugging). */
export function getKeepExceptionUids(): string[] {
  return Object.keys(loadExceptions()).sort();
}

/**
 * True when the uid would NOT be re-prompted right now (exception or already
 * pending) — the engine's single check before enqueuing.
 */
export function wouldPromptBeSuppressed(uid: string): boolean {
  return hasKeepException(uid) || isQueued(uid);
}