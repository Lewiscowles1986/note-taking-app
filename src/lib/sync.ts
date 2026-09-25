/**
 * Per-note two-way sync against a REST JSON server.
 *
 * Protocol (documented in docs/sync.md):
 *   GET    {server}/api/notes           → { notes: [{ uid, updatedAt, deleted? }] }
 *   GET    {server}/api/notes/{uid}     → full note JSON (the sync payload shape)
 *   PUT    {server}/api/notes/{uid}     → upsert full note JSON (204/200)
 *   DELETE {server}/api/notes/{uid}     → tombstone the remote note (204/200)
 *
 * Auth: `Authorization: Bearer <token>` when a token is configured.
 *
 * Conflict resolution is last-writer-wins per note on `updatedAt`. Deletions
 * propagate through tombstones on both sides: local deletions are remembered
 * in localStorage (see syncSettings.ts), remote deletions appear in the
 * manifest as `deleted: true`. An edit newer than a deletion resurrects the
 * note by pushing it.
 *
 * Encrypted notes are synced only in their encrypted form (content is the
 * "[encrypted]" placeholder plus the EncryptedPayload) — plaintext never
 * leaves the device.
 *
 * The planner (`planSync`) is a pure function over plain data so the merge
 * semantics can be unit-tested without any network; `runSync` is the thin
 * orchestrator that gathers state, executes the plan and records the outcome.
 */

import { db, detectContentFeatures, type Note } from './db';
import {
  loadTombstonesFor,
  recordSyncResultFor,
  resolveSyncDecision,
  retainTombstonesFor,
  type Tombstone,
} from './syncSettings';
import { listServers, getServerSettings, uidMapKey, remoteCategoriesKey } from './syncServers';
import { resolveAuthToken } from './authToken';
import {
  enqueueRemoteDeletion,
  hasKeepException,
  wouldPromptBeSuppressed,
} from './syncNotifications';

// ─── uid mapping (localStorage-backed; keeps the Dexie schema unchanged) ─────

// One map PER SERVER: a note synced to two servers carries a DIFFERENT uid
// on each (uids are generated per-push), so the keying is per-server.

type UidMap = Record<string, string>; // noteId (as string) -> uid

function loadUidMapFor(serverId: string): UidMap {
  try {
    const raw = localStorage.getItem(uidMapKey(serverId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: UidMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function saveUidMapFor(serverId: string, map: UidMap): void {
  localStorage.setItem(uidMapKey(serverId), JSON.stringify(map));
}

/**
 * uid → category of the last payload seen for that uid (localStorage, per
 * server). Lets category-scoped syncs exclude manifest entries WITHOUT
 * fetching their payloads: once a uid is known out-of-scope it is invisible
 * until its category changes (which can only be observed by a pull that is
 * in scope).
 */
function loadRemoteCategoriesFor(serverId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(remoteCategoriesKey(serverId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [uid, category] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof category === 'string' && category) out[uid] = category;
    }
    return out;
  } catch {
    return {};
  }
}

function rememberRemoteCategoryFor(serverId: string, uid: string, category: string): void {
  const map = loadRemoteCategoriesFor(serverId);
  if (map[uid] === category) return;
  map[uid] = category;
  localStorage.setItem(remoteCategoriesKey(serverId), JSON.stringify(map));
}

/** Existing sync uid for a note ON ONE SERVER, if any. */
export function getUidForNoteId(serverId: string, noteId: number): string | null {
  return loadUidMapFor(serverId)[String(noteId)] ?? null;
}

/**
 * Assign (once) and return the sync uid for a note ON ONE SERVER. Uses
 * crypto.randomUUID when available, falling back to timestamp+random — uids
 * only need to be unique (per server), never secret. Two servers carry
 * INDEPENDENT uids for the same local note.
 */
export function assignUidForNoteId(serverId: string, noteId: number): string {
  const map = loadUidMapFor(serverId);
  const key = String(noteId);
  if (map[key]) return map[key];
  const uid =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  map[key] = uid;
  saveUidMapFor(serverId, map);
  return uid;
}

function forgetUidFor(serverId: string, noteId: number): void {
  const map = loadUidMapFor(serverId);
  delete map[String(noteId)];
  saveUidMapFor(serverId, map);
}

/**
 * Execute the user's DELETE decision on a queued remote-deletion prompt FOR
 * ONE SERVER: remove the local copy (revisions included) and forget the uid
 * mapping in that server's map. No new tombstone is recorded — the remote
 * side is already tombstoned, so there is nothing left to propagate; any
 * stale local tombstone for the uid is dropped to keep storage tidy. The
 * caller (SyncNotifications) removes the queue entry after this resolves.
 * Imported dynamically by the notification UI so the engine stays out of the
 * eager chunk.
 */
export async function deleteNoteForUid(serverId: string, uid: string): Promise<boolean> {
  const map = loadUidMapFor(serverId);
  const key = Object.keys(map).find((k) => map[k] === uid);
  if (!key) return false;
  const noteId = Number(key);
  await db.revisions.where('noteId').equals(noteId).delete();
  await db.notes.delete(noteId);
  forgetUidFor(serverId, noteId);
  return true;
}

/** Prune mappings pointing at notes that no longer exist (e.g. after a restore). */
export function pruneUidMap(serverId: string, liveNoteIds: number[]): void {
  const live = new Set(liveNoteIds.map(String));
  const map = loadUidMapFor(serverId);
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!live.has(key)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) saveUidMapFor(serverId, map);
}

// ─── payload shape ───────────────────────────────────────────────────────────

/** JSON-ready note as it travels over the wire (dates as ISO strings). */
export interface SyncPayload {
  uid: string;
  title: string;
  content: string;
  tags: string[];
  category: string;
  attachments: Note['attachments'];
  createdAt: string;
  updatedAt: string;
  editDates: string[];
  pinned: boolean;
  hasCodeBlocks?: boolean;
  hasMermaid?: boolean;
  hasGeoJson?: boolean;
  hasModel3D?: boolean;
  encrypted?: Note['encrypted'];
}

/** Manifest entry describing a remote note without its body. */
export interface RemoteNoteMeta {
  uid: string;
  updatedAt: string;
  deleted?: boolean;
}

/** Serializable view of a local note the planner works on. */
export interface LocalNoteMeta {
  noteId: number;
  uid: string;
  title: string;
  updatedAt: string;
  /** Category — lets the orchestrator pre-filter by sync scope. */
  category?: string;
}

export function buildSyncPayload(note: Note, uid: string): SyncPayload {
  return {
    uid,
    title: note.title,
    content: note.content,
    tags: [...note.tags],
    category: note.category,
    attachments: note.attachments,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    editDates: [...(note.editDates || [])],
    pinned: !!note.pinned,
    hasCodeBlocks: note.hasCodeBlocks,
    hasMermaid: note.hasMermaid,
    hasGeoJson: note.hasGeoJson,
    hasModel3D: note.hasModel3D,
    encrypted: note.encrypted ?? null,
  };
}

/** Convert a wire payload into a Dexie-shaped Note (dates re-hydrated). */
export function payloadToNote(payload: SyncPayload): Note {
  const now = new Date();
  const content = typeof payload.content === 'string' ? payload.content : '';
  const createdAt = safeDate(payload.createdAt) ?? now;
  const updatedAt = safeDate(payload.updatedAt) ?? createdAt;
  const features = detectContentFeatures(content);
  return {
    title: typeof payload.title === 'string' && payload.title ? payload.title : 'Untitled',
    content,
    tags: Array.isArray(payload.tags) ? [...payload.tags] : [],
    category: typeof payload.category === 'string' && payload.category ? payload.category : 'General',
    attachments: Array.isArray(payload.attachments) ? [...payload.attachments] : [],
    createdAt,
    updatedAt,
    editDates: Array.isArray(payload.editDates)
      ? Array.from(new Set(payload.editDates.map((d) => String(d))))
      : [now.toISOString().slice(0, 10)],
    pinned: payload.pinned === true,
    hasCodeBlocks: payload.hasCodeBlocks ?? features.hasCodeBlocks,
    hasMermaid: payload.hasMermaid ?? features.hasMermaid,
    hasGeoJson: payload.hasGeoJson ?? features.hasGeoJson,
    hasModel3D: payload.hasModel3D ?? features.hasModel3D,
    encrypted: payload.encrypted ?? null,
  };
}

function safeDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// ─── the pure planner ────────────────────────────────────────────────────────

export type SyncOp =
  | { kind: 'push'; uid: string; noteId: number }
  | { kind: 'pull'; uid: string; noteId: number | null }
  | { kind: 'delete-local'; uid: string; noteId: number }
  | { kind: 'delete-remote'; uid: string };

function newerThan(a: string, b: string): boolean {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return false;
  if (!Number.isFinite(bMs)) return true;
  return aMs > bMs;
}

/**
 * Compute the set of operations that brings both sides in sync, comparing
 * per-note `updatedAt` timestamps (last-writer-wins).
 *
 * Rules, per uid:
 *  - on both sides, none deleted: newer side wins (push/pull), equal = no-op
 *  - remote deleted: an older local copy is deleted locally; a local copy
 *    edited after the deletion is pushed (resurrection)
 *  - local-only note: push (a note that exists locally exists as content —
 *    deletion propagation is driven purely by tombstones below, since a
 *    deleted note no longer appears in `local`)
 *  - pending tombstone with the note still on the server: our deletion is
 *    newer than their copy → delete-remote; their copy is newer → pull
 *    (their post-deletion edit wins and the note is resurrected locally)
 *  - remote-only, not deleted: new note → pull
 */
export function planSync(
  local: LocalNoteMeta[],
  remote: RemoteNoteMeta[],
  tombstones: Tombstone[],
): SyncOp[] {
  const ops: SyncOp[] = [];
  const remoteByUid = new Map(remote.map((r) => [r.uid, r]));
  const tombstoneByUid = new Map(tombstones.map((t) => [t.uid, t]));
  const seenUids = new Set<string>();

  for (const entry of local) {
    seenUids.add(entry.uid);
    const meta = remoteByUid.get(entry.uid);

    if (!meta) {
      ops.push({ kind: 'push', uid: entry.uid, noteId: entry.noteId });
      continue;
    }

    if (meta.deleted) {
      // Remote tombstone: local edit newer than the deletion resurrects.
      if (newerThan(entry.updatedAt, meta.updatedAt)) {
        ops.push({ kind: 'push', uid: entry.uid, noteId: entry.noteId });
      } else {
        ops.push({ kind: 'delete-local', uid: entry.uid, noteId: entry.noteId });
      }
      continue;
    }

    if (newerThan(entry.updatedAt, meta.updatedAt)) {
      ops.push({ kind: 'push', uid: entry.uid, noteId: entry.noteId });
    } else if (newerThan(meta.updatedAt, entry.updatedAt)) {
      ops.push({ kind: 'pull', uid: entry.uid, noteId: entry.noteId });
    }
    // Equal timestamps: already in sync.
  }

  for (const meta of remote) {
    if (seenUids.has(meta.uid)) continue;
    // Uids with a pending local tombstone are decided in the tombstone pass
    // below (pull-after-remote-edit vs delete-remote) — not here.
    if (!meta.deleted && !tombstoneByUid.has(meta.uid)) {
      ops.push({ kind: 'pull', uid: meta.uid, noteId: null });
    }
    // Remote-only deleted entries: nothing local to remove — ignore.
  }

  // Pending local deletions: the note is gone locally, so only the tombstone
  // speaks for it. Three cases:
  //  - note still on the server, older than the deletion → propagate (delete-remote)
  //  - note edited on the server after the deletion → their edit wins (pull)
  //  - note absent from the manifest → the server no longer has it; the
  //    tombstone has nothing to act on and is simply consumed.
  // A live local note with the same uid (stale tombstone) is never touched.
  for (const tombstone of tombstones) {
    if (seenUids.has(tombstone.uid)) continue;
    const meta = remoteByUid.get(tombstone.uid);
    if (!meta || meta.deleted) continue;
    if (newerThan(meta.updatedAt, tombstone.deletedAt)) {
      ops.push({ kind: 'pull', uid: tombstone.uid, noteId: null });
    } else {
      ops.push({ kind: 'delete-remote', uid: tombstone.uid });
    }
  }

  return ops;
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  errors: string[];
  summary: string;
}

export class SyncError extends Error {}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Common headers. Content-Type is set only when a body is present — a
 * Content-Type header on bodyless GET/DELETE would turn them into
 * non-simple CORS requests and trigger a pointless preflight.
 */
function authHeaders(token: string, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Build the Authorization header for an outgoing request. The token comes
 * from resolveAuthToken (that server's OIDC session when signed in, else that
 * server's manual bearer token) — the engine itself stays OIDC-agnostic.
 */
async function bearerHeaders(
  serverId: string,
  manualToken: string,
  fetchImpl: FetchLike,
  hasBody = false,
): Promise<Record<string, string>> {
  const token = await resolveAuthToken(serverId, manualToken, fetchImpl as unknown as typeof fetch);
  return authHeaders(token, hasBody);
}

/** Exclusion lists advertised by a server in its discovery document. */
export interface ServerExclusions {
  excludedCategories: string[];
  excludedUids: string[];
}

const NO_EXCLUSIONS: ServerExclusions = { excludedCategories: [], excludedUids: [] };

/**
 * Extract `notes.excluded_categories` / `notes.excluded_uids` from a discovery
 * document. Tolerates absent/invalid shapes (older servers, wrong types) by
 * returning empty lists — the server still enforces its own policy on PUT.
 */
export function parseDiscoveryExclusions(data: unknown): ServerExclusions {
  const notes = (data as { notes?: unknown } | null)?.notes;
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return { ...NO_EXCLUSIONS };
  const toList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  return {
    excludedCategories: toList((notes as { excluded_categories?: unknown }).excluded_categories),
    excludedUids: toList((notes as { excluded_uids?: unknown }).excluded_uids),
  };
}

async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  what: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new SyncError(`${what}: network error — ${e instanceof Error ? e.message : e}`);
  }
  if (!response.ok) {
    throw new SyncError(`${what}: server responded ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SyncError(`${what}: server returned invalid JSON`);
  }
}

/**
 * Read the server's exclusion policy from its discovery document. Best-effort:
 * an unreachable/undecipherable discovery endpoint yields empty lists so sync
 * proceeds — the server still enforces its own policy with 403 on PUT.
 */
export async function fetchServerExclusions(
  base: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<ServerExclusions> {
  try {
    const doc = await requestJson<unknown>(
      fetchImpl,
      `${base}/.well-known/openid-configuration`,
      { method: 'GET', headers: {}, signal },
      'Reading server sync policy',
    );
    return parseDiscoveryExclusions(doc);
  } catch {
    return { ...NO_EXCLUSIONS };
  }
}

/** Extract a manifest array from the GET /api/notes response (array or { notes }). */
export function parseManifest(data: unknown): RemoteNoteMeta[] {
  const list: unknown = Array.isArray(data) ? data : (data as { notes?: unknown })?.notes;
  if (!Array.isArray(list)) throw new SyncError('Unexpected manifest format from server');
  return list
    .filter(
      (item): item is RemoteNoteMeta =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as RemoteNoteMeta).uid === 'string' &&
        typeof (item as RemoteNoteMeta).updatedAt === 'string' &&
        Number.isFinite(Date.parse((item as RemoteNoteMeta).updatedAt)),
    )
    .map((m) => ({ uid: m.uid, updatedAt: m.updatedAt, deleted: m.deleted === true }));
}

function describe(result: Omit<SyncResult, 'summary' | 'ok'>, queuedDeletions = 0): string {
  const parts: string[] = [];
  if (result.pushed) parts.push(`${result.pushed} pushed`);
  if (result.pulled) parts.push(`${result.pulled} pulled`);
  if (result.deletedLocal) parts.push(`${result.deletedLocal} removed locally`);
  if (result.deletedRemote) parts.push(`${result.deletedRemote} deleted on server`);
  if (queuedDeletions) parts.push(`${queuedDeletions} deletion${queuedDeletions !== 1 ? 's' : ''} awaiting your choice`);
  if (result.errors.length) parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'already up to date';
}

/**
 * Run one full sync round across ALL configured servers (or ONE, when
 * `serverId` is given). Servers fail independently: one that dies fatally
 * (unreachable base, bad manifest, abort) folds into the aggregate as a
 * `[label] message` error with `ok: false` while the other servers' counts
 * and summary lines survive. Only 'no server configured' throws; per-op
 * failures are collected into `errors` and do not abort the remaining
 * operations.
 *
 * Policy baked in here (docs/sync.md):
 *  - Never-delete-local: remote deletions never remove local notes. The
 *    planner may emit `delete-local` intents; runSync converts them into
 *    notification-queue entries (keep-or-delete prompts) instead of deleting.
 *  - Category scope: when the stored scope is 'categories', only notes in the
 *    chosen categories are pushed or pulled; out-of-scope remote entries —
 *    including their deletions — are ignored entirely.
 */
export async function runSync(options: {
  /** Which server to sync. Default: ALL configured servers, independently
   * (each with its own settings, uids, tombstones and tokens). */
  serverId?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: Date;
} = {}): Promise<SyncResult> {
  if (options.serverId) return runSyncOne(options.serverId, options);
  const servers = listServers();
  if (servers.length === 0) throw new SyncError('No sync server configured');
  const settled = await Promise.allSettled(
    servers.map((server) => runSyncOne(server.id, options)),
  );
  // Aggregate: survivors' ops are summed and keep their labelled summary
  // lines; a REJECTED server (unreachable base, bad manifest, abort) folds in
  // as a `[label] message` error instead of losing every other server's
  // completed work the way Promise.all did.
  const labelFor = (i: number): string => servers[i].label ?? servers[i].id;
  const reasonText = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason);
  const okResults: { result: SyncResult; i: number }[] = [];
  const rejected: { reason: unknown; i: number }[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') okResults.push({ result: outcome.value, i });
    else rejected.push({ reason: outcome.reason, i });
  });
  const ok = rejected.length === 0 && okResults.every(({ result }) => result.ok);
  const errors = [
    ...okResults.flatMap(({ result, i }) =>
      result.errors.length && servers[i].label && servers[i].label !== servers[i].id
        ? result.errors.map((e) => `[${servers[i].label}] ${e}`)
        : result.errors,
    ),
    ...rejected.map(({ reason, i }) => `[${labelFor(i)}] ${reasonText(reason)}`),
  ];
  const summary = settled
    .map((outcome, i) => {
      const label = labelFor(i);
      const named = settled.length > 1 && servers[i].label !== servers[i].id ? `${label}: ` : '';
      return `${named}${outcome.status === 'fulfilled' ? outcome.value.summary : reasonText(outcome.reason)}`;
    })
    .join(' · ');
  return {
    ok,
    pushed: okResults.reduce((n, { result }) => n + result.pushed, 0),
    pulled: okResults.reduce((n, { result }) => n + result.pulled, 0),
    deletedLocal: okResults.reduce((n, { result }) => n + result.deletedLocal, 0),
    deletedRemote: okResults.reduce((n, { result }) => n + result.deletedRemote, 0),
    errors,
    summary,
  };
}

/**
 * Run one full sync round against ONE server. Throws SyncError for fatal
 * problems (no config, unreachable server, bad manifest); per-op failures
 * are collected into `errors` and do not abort the remaining operations.
 *
 * Policy baked in here (docs/sync.md):
 *  - Never-delete-local: remote deletions never remove local notes. The
 *    planner may emit `delete-local` intents; runSync converts them into
 *    notification-queue entries (keep-or-delete prompts) instead of deleting.
 *  - Category scope: when the stored scope is 'categories', only notes in the
 *    chosen categories are pushed or pulled; out-of-scope remote entries —
 *    including their deletions — are ignored entirely.
 *  - Everything below is SCOPED TO THE SERVER: settings, uid map,
 *    tombstones, remote-category cache, tokens, notifications, exceptions.
 */
async function runSyncOneBody(serverId: string, options: {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const settings = getServerSettings(serverId);
  if (!settings.serverUrl) {
    throw new SyncError('No sync server configured');
  }
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const base = settings.serverUrl;

  // Local state: notes + uid mapping (assigning fresh uids to new notes and
  // pruning mappings for notes that no longer exist). Per-server map.
  const notes = await db.notes.toArray();
  const liveIds = notes.map((n) => n.id!);
  pruneUidMap(serverId, liveIds);

  // Layer 1 — the server's exclusion policy, read from discovery each run.
  const serverExclusions = await fetchServerExclusions(base, fetchImpl, options.signal);

  /** The ONE sync/not-sync decision for a note (deny always wins). */
  const decide = (noteId: number, uid: string, category: string) =>
    resolveSyncDecision({
      serverExcludedCategories: serverExclusions.excludedCategories,
      serverExcludedUids: serverExclusions.excludedUids,
      uid,
      noteId,
      category,
      syncScope: settings.syncScope,
      syncedCategories: settings.syncedCategories,
      excludedCategories: settings.excludedCategories,
      excludedNoteIds: settings.excludedNoteIds,
    });

  // Excluded/out-of-scope notes keep their uid mapping (a later move back
  // into scope syncs normally) but are invisible to this sync round —
  // neither pushed, pulled, nor prompted about.
  const localMetas: LocalNoteMeta[] = notes
    .filter((n) => decide(n.id!, assignUidForNoteId(serverId, n.id!), n.category).decision === 'sync')
    .map((n) => ({
      noteId: n.id!,
      uid: assignUidForNoteId(serverId, n.id!),
      title: n.title,
      updatedAt: new Date(n.updatedAt).toISOString(),
      category: n.category,
    }));
  const tombstones = loadTombstonesFor(serverId);

  // Authorization: that server's OIDC access token when a session exists
  // (refreshing via the resolver seam), else that server's manual token.
  const manifestHeaders = await bearerHeaders(serverId, settings.authToken, fetchImpl);

  // Remote manifest.
  const manifestData = await requestJson<unknown>(
    fetchImpl,
    `${base}/api/notes`,
    { method: 'GET', headers: manifestHeaders, signal: options.signal },
    'Fetching remote changes',
  );
  const remote = parseManifest(manifestData);

  // Remote manifest entries are filtered through the SAME decision function:
  // a uid whose stored category is known client-denied/server-denied/out-of-
  // scope is invisible to this round WITHOUT fetching its payload. Unknown
  // uids are fetched once; if their payload turns out excluded they land in
  // the category cache and are skipped from the next run on. Uids on the
  // server's deny list are filtered unconditionally — even when their
  // category is not yet known — so their payload is never fetched at all.
  const remoteCategories = loadRemoteCategoriesFor(serverId);
  const excludedUidSet = new Set(serverExclusions.excludedUids);
  const remoteInScope = remote.filter((r) => {
    if (excludedUidSet.has(r.uid)) return false;
    const known = remoteCategories[r.uid];
    if (known === undefined) return true;
    return decide(-1, r.uid, known).decision === 'sync';
  });

  // Local notes by uid for titles/categories in notifications.
  const noteByUid = new Map(localMetas.map((m) => [m.uid, m]));
  const noteIdByUid = new Map(notes.map((n) => [assignUidForNoteId(serverId, n.id!), n]));

  const plan = planSync(localMetas, remoteInScope, tombstones);

  const result: Omit<SyncResult, 'summary' | 'ok'> = {
    pushed: 0,
    pulled: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    errors: [],
  };
  /** Remote deletions turned into keep-or-delete prompts this run. */
  let notifiedDeletions = 0;

  /** Uids whose delete-remote completed on the server (tombstone consumed). */
  const acknowledgedDeletions = new Set<string>();

  for (const op of plan) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      if (op.kind === 'push') {
        const note = await db.notes.get(op.noteId);
        if (!note) continue;
        const payload = buildSyncPayload(note, op.uid);
        await requestJson(
          fetchImpl,
          `${base}/api/notes/${encodeURIComponent(op.uid)}`,
          {
            method: 'PUT',
            headers: await bearerHeaders(serverId, settings.authToken, fetchImpl, true),
            body: JSON.stringify(payload),
            signal: options.signal,
          },
          `Pushing "${note.title}"`,
        );
        result.pushed++;
      } else if (op.kind === 'pull') {
        const payload = await requestJson<SyncPayload>(
          fetchImpl,
          `${base}/api/notes/${encodeURIComponent(op.uid)}`,
          { method: 'GET', headers: await bearerHeaders(serverId, settings.authToken, fetchImpl), signal: options.signal },
          'Pulling note',
        );
        // Re-check the decision on the payload: the manifest entry looked
        // syncable, but the stored payload's category is authoritative — a
        // note that moved into an excluded/out-of-scope category on another
        // device must not be pulled in.
        const payloadDecision = decide(-1, op.uid, payload.category);
        rememberRemoteCategoryFor(serverId, op.uid, payload.category);
        if (payloadDecision.decision === 'skip') {
          continue;
        }
        const note = payloadToNote(payload);
        if (op.noteId != null) {
          await db.notes.update(op.noteId, { ...note });
        } else {
          const newId = await db.notes.add(note);
          const map = loadUidMapFor(serverId);
          map[String(newId)] = op.uid;
          saveUidMapFor(serverId, map);
        }
        result.pulled++;
      } else if (op.kind === 'delete-local') {
        // NEVER-DELETE POLICY: a remote deletion must not remove the local
        // note. Queue a keep-or-delete prompt instead (unless this client
        // already has a permanent exception, a pending prompt for the uid, or
        // the note is excluded from sync — an excluded note is not managed,
        // so its deletion is none of this client's business).
        const meta = noteByUid.get(op.uid);
        const noteInfo = noteIdByUid.get(op.uid);
        const excludedNote = meta
          ? decide(meta.noteId, op.uid, meta.category).reason !== 'allowed'
          : !!noteInfo && decide(noteInfo.id!, op.uid, noteInfo.category).reason !== 'allowed';
        if (!wouldPromptBeSuppressed(serverId, op.uid) && !excludedNote) {
          enqueueRemoteDeletion({
            serverId,
            uid: op.uid,
            title: meta?.title ?? noteInfo?.title ?? 'Untitled',
            category: meta?.category ?? noteInfo?.category ?? 'General',
            deletedAt: remote.find((r) => r.uid === op.uid)?.updatedAt ?? new Date().toISOString(),
          });
          notifiedDeletions++;
        }
      } else if (op.kind === 'delete-remote') {
        await requestJson(
          fetchImpl,
          `${base}/api/notes/${encodeURIComponent(op.uid)}`,
          { method: 'DELETE', headers: await bearerHeaders(serverId, settings.authToken, fetchImpl), signal: options.signal },
          'Deleting remote note',
        );
        acknowledgedDeletions.add(op.uid);
        result.deletedRemote++;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      result.errors.push(e instanceof Error ? e.message : String(e));
      // delete-remote failures keep their tombstone for the next run; all
      // other op failures need no bookkeeping.
    }
  }

  // Tombstones whose DELETE completed have served their purpose; keep the
  // rest (failed deletes retry next run; consumed-and-empty storage clears).
  if (acknowledgedDeletions.size > 0) {
    const keep = new Set(
      tombstones.map((t) => t.uid).filter((uid) => !acknowledgedDeletions.has(uid)),
    );
    retainTombstonesFor(serverId, keep);
  }

  const summary = describe(result, notifiedDeletions);
  recordSyncResultFor(serverId, {
    at: (options.now ?? new Date()).toISOString(),
    ok: result.errors.length === 0,
    summary,
  });

  return {
    ok: result.errors.length === 0,
    ...result,
    summary,
  };
}

/**
 * Fatal-failure wrapper around runSyncOneBody. The body records a successful
 * (or per-op-failed) lastSync itself, but a fatal throw — unreachable base,
 * bad manifest, abort — used to skip that entirely, leaving the servers-page
 * row at a lying 'Never synced'. Record a failed lastSync first, then
 * rethrow so callers keep their error handling.
 */
async function runSyncOne(serverId: string, options: {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<SyncResult> {
  try {
    return await runSyncOneBody(serverId, options);
  } catch (e) {
    recordSyncResultFor(serverId, {
      at: (options.now ?? new Date()).toISOString(),
      ok: false,
      summary: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/**
 * Auto-sync tick: silently sync EVERY configured server that has a server
 * URL (each with its own settings/tokens). Intended for the background
 * interval — never throws. Returns the aggregated result, or null when
 * nothing is configured.
 */
export async function runSyncIfConfigured(serverId?: string, signal?: AbortSignal): Promise<SyncResult | null> {
  try {
    const servers = listServers();
    if (serverId) {
      if (!servers.some((s) => s.id === serverId)) return null;
      return await runSync({ serverId, signal });
    }
    if (servers.length === 0) return null;
    return await runSync({ signal });
  } catch {
    return null;
  }
}