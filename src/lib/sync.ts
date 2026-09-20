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
  loadSyncSettings,
  loadTombstones,
  recordSyncResult,
  recordTombstone,
  retainTombstones,
  type Tombstone,
} from './syncSettings';

// ─── uid mapping (localStorage-backed; keeps the Dexie schema unchanged) ─────

const UID_MAP_KEY = 'notehaven.sync.uidMap';

type UidMap = Record<string, string>; // noteId (as string) -> uid

function loadUidMap(): UidMap {
  try {
    const raw = localStorage.getItem(UID_MAP_KEY);
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

function saveUidMap(map: UidMap): void {
  localStorage.setItem(UID_MAP_KEY, JSON.stringify(map));
}

/** Existing sync uid for a note, if any. */
export function getUidForNoteId(noteId: number): string | null {
  return loadUidMap()[String(noteId)] ?? null;
}

/**
 * Assign (once) and return the sync uid for a note. Uses crypto.randomUUID
 * when available, falling back to timestamp+random — uids only need to be
 * unique, never secret.
 */
export function assignUidForNoteId(noteId: number): string {
  const map = loadUidMap();
  const key = String(noteId);
  if (map[key]) return map[key];
  const uid =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  map[key] = uid;
  saveUidMap(map);
  return uid;
}

function forgetUid(noteId: number): void {
  const map = loadUidMap();
  delete map[String(noteId)];
  saveUidMap(map);
}

/** Prune mappings pointing at notes that no longer exist (e.g. after a restore). */
export function pruneUidMap(liveNoteIds: number[]): void {
  const live = new Set(liveNoteIds.map(String));
  const map = loadUidMap();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!live.has(key)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) saveUidMap(map);
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

function describe(result: Omit<SyncResult, 'summary' | 'ok'>): string {
  const parts: string[] = [];
  if (result.pushed) parts.push(`${result.pushed} pushed`);
  if (result.pulled) parts.push(`${result.pulled} pulled`);
  if (result.deletedLocal) parts.push(`${result.deletedLocal} removed locally`);
  if (result.deletedRemote) parts.push(`${result.deletedRemote} deleted on server`);
  if (result.errors.length) parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(', ') : 'already up to date';
}

/**
 * Run one full sync round. Throws SyncError for fatal problems (no config,
 * unreachable server, bad manifest); per-op failures are collected into
 * `errors` and do not abort the remaining operations.
 */
export async function runSync(options: {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: Date;
} = {}): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const settings = loadSyncSettings();
  if (!settings.serverUrl) {
    throw new SyncError('No sync server configured');
  }
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const base = settings.serverUrl;

  // Local state: notes + uid mapping (assigning fresh uids to new notes and
  // pruning mappings for notes that no longer exist).
  const notes = await db.notes.toArray();
  const liveIds = notes.map((n) => n.id!);
  pruneUidMap(liveIds);
  const localMetas: LocalNoteMeta[] = notes.map((n) => ({
    noteId: n.id!,
    uid: assignUidForNoteId(n.id!),
    title: n.title,
    updatedAt: new Date(n.updatedAt).toISOString(),
  }));
  const tombstones = loadTombstones();

  // Remote manifest.
  const manifestData = await requestJson<unknown>(
    fetchImpl,
    `${base}/api/notes`,
    { method: 'GET', headers: authHeaders(settings.authToken), signal: options.signal },
    'Fetching remote changes',
  );
  const remote = parseManifest(manifestData);

  const plan = planSync(localMetas, remote, tombstones);

  const result: Omit<SyncResult, 'summary' | 'ok'> = {
    pushed: 0,
    pulled: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    errors: [],
  };

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
            headers: authHeaders(settings.authToken, true),
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
          { method: 'GET', headers: authHeaders(settings.authToken), signal: options.signal },
          'Pulling note',
        );
        const note = payloadToNote(payload);
        if (op.noteId != null) {
          await db.notes.update(op.noteId, note);
        } else {
          const newId = await db.notes.add(note);
          const map = loadUidMap();
          map[String(newId)] = op.uid;
          saveUidMap(map);
        }
        result.pulled++;
      } else if (op.kind === 'delete-local') {
        await db.revisions.where('noteId').equals(op.noteId).delete();
        await db.notes.delete(op.noteId);
        forgetUid(op.noteId);
        result.deletedLocal++;
      } else if (op.kind === 'delete-remote') {
        await requestJson(
          fetchImpl,
          `${base}/api/notes/${encodeURIComponent(op.uid)}`,
          { method: 'DELETE', headers: authHeaders(settings.authToken), signal: options.signal },
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
    retainTombstones(keep);
  }

  const summary = describe(result);
  recordSyncResult({ at: (options.now ?? new Date()).toISOString(), ok: result.errors.length === 0, summary });

  return {
    ok: result.errors.length === 0,
    ...result,
    summary,
  };
}

/**
 * Auto-sync tick: silently run a sync when a server is configured. Intended
 * for the background interval — never throws.
 */
export async function runSyncIfConfigured(signal?: AbortSignal): Promise<SyncResult | null> {
  try {
    const { serverUrl } = loadSyncSettings();
    if (!serverUrl) return null;
    return await runSync({ signal });
  } catch {
    return null;
  }
}