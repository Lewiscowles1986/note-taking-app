/**
 * Unit tests for the never-delete policy, category-scoped sync and the
 * notification queue (src/lib/sync.ts, syncNotifications.ts, syncSettings
 * scope fields).
 *
 * Key guarantees under test:
 *  - runSync NEVER removes a local note because the server says deleted —
 *    it queues a keep-or-delete prompt instead (asserted against
 *    fake-indexeddb state).
 *  - Local user deletions still propagate as remote tombstones.
 *  - Scope filtering: out-of-scope notes are neither pushed nor pulled;
 *    a note moving out of scope keeps its local copy and uid; a note moving
 *    into scope syncs normally; out-of-scope remote deletions are ignored.
 *  - The notification queue dedupes, honours permanent exceptions, and the
 *    keep/delete decisions do the right thing (including remote resurrection
 *    after a Keep).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, detectContentFeatures, getAllNotes, type Note } from '@/lib/db';
import {
  runSync,
  planSync,
  getUidForNoteId,
  assignUidForNoteId,
  type LocalNoteMeta,
  type RemoteNoteMeta,
} from '@/lib/sync';
import {
  loadSyncSettings,
  saveSyncSettings,
  clearSyncSettings,
  recordTombstoneFor,
  loadTombstonesFor,
  isCategoryInScope,
} from '@/lib/syncSettings';
import {
  getPendingNotifications,
  enqueueRemoteDeletion,
  resolveNotification,
  hasKeepException,
  addKeepException,
  getKeepExceptionUids,
  isQueued,
  wouldPromptBeSuppressed,
  type SyncNotification,
} from '@/lib/syncNotifications';
import { deleteNoteForUid } from '@/lib/sync';
import { addServer, saveServerSettings } from '@/lib/syncServers';

// All notifications tests run against ONE configured test server.
const SRV = 'https://sync.test';
/** Server-scoped wrappers matching the ONE-server shape of these tests. */
const pending = () => getPendingNotifications(SRV);
const queue = (info: Omit<Parameters<typeof enqueueRemoteDeletion>[0], 'serverId'>) =>
  enqueueRemoteDeletion({ ...info, serverId: SRV });

const iso = (ms: number): string => new Date(ms).toISOString();
const T0 = Date.now();

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

async function seedNote(overrides: Partial<Note> = {}): Promise<number> {
  const now = new Date(T0);
  const content = overrides.content ?? 'body';
  return db.notes.add({
    title: 'Seeded',
    content,
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: now,
    updatedAt: now,
    editDates: ['2026-01-01'],
    pinned: false,
    encrypted: null,
    ...detectContentFeatures(content),
    ...overrides,
  });
}

function makeFullPayload(uid: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    uid,
    title: 'From server',
    content: 'remote body',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: iso(T0 - 1000),
    updatedAt: iso(T0),
    editDates: ['2026-01-01'],
    pinned: false,
    encrypted: null,
    ...overrides,
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

function makeFetch(
  handlers: Array<{
    match: { method?: string; urlIncludes?: string };
    status?: number;
    json?: unknown;
  }> = [],
) {
  const requests: RecordedRequest[] = [];
  const ordered = [...handlers].sort(
    (a, b) => (b.match.urlIncludes?.length ?? 0) - (a.match.urlIncludes?.length ?? 0),
  );
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body, headers });
    const handler = ordered.find(
      (h) =>
        (!h.match.method || h.match.method.toUpperCase() === method) &&
        (!h.match.urlIncludes || url.includes(h.match.urlIncludes)),
    );
    if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
    const status = handler.status ?? 200;
    const payload =
      status === 204 || status === 205 || status === 304
        ? null
        : handler.json !== undefined
          ? JSON.stringify(handler.json)
          : '';
    return new Response(payload, { status });
  };
  return { impl: impl as unknown as typeof fetch, requests };
}

function configureServer(overrides: Record<string, unknown> = {}): void {
  addServer(SRV);
  saveServerSettings(SRV, {
    authToken: 'secret-token',
    autoSync: false,
    intervalMinutes: 15,
    syncScope: 'all',
    syncedCategories: [],
    excludedCategories: [],
    excludedNoteIds: [],
    lastSync: null,
    ...overrides,
  });
}

beforeEach(async () => {
  await resetDb();
  localStorage.clear();
});

// ─── scope helpers (syncSettings) ────────────────────────────────────────────

describe('isCategoryInScope', () => {
  it("scope 'all' includes every category", () => {
    expect(isCategoryInScope('Work', 'all', [])).toBe(true);
    expect(isCategoryInScope('anything', 'all', ['Work'])).toBe(true);
  });

  it("scope 'categories' requires membership", () => {
    expect(isCategoryInScope('Work', 'categories', ['Work', 'Life'])).toBe(true);
    expect(isCategoryInScope('Nope', 'categories', ['Work'])).toBe(false);
  });

  it("an empty selection under 'categories' syncs nothing", () => {
    expect(isCategoryInScope('Work', 'categories', [])).toBe(false);
  });
});

// ─── push/pull scope filtering in runSync ────────────────────────────────────

describe('category-scoped sync', () => {
  it('does not PUSH a note whose category is out of scope (uid mapping kept)', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    const inId = await seedNote({ title: 'In scope', category: 'Work' });
    const outId = await seedNote({ title: 'Out of scope', category: 'Personal' });
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pushed).toBe(1);
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(requests.find((r) => r.method === 'PUT')!.body.title).toBe('In scope');

    // The out-of-scope note keeps its uid mapping for a later move back in.
    expect(getUidForNoteId(SRV, outId)).not.toBeNull();
    expect(getUidForNoteId(SRV, inId)).not.toBeNull();
  });

  it('does not PULL (or plan delete-local for) an out-of-scope remote note', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    // First run: the out-of-scope uid is unknown → its payload is fetched once,
    // recognized as out of scope, NOT stored, and its category is cached.
    const { impl, requests } = makeFetch([
      {
        match: { method: 'GET' },
        json: {
          notes: [
            { uid: 'out-1', updatedAt: iso(T0) }, // in manifest, out of scope
            { uid: 'in-1', updatedAt: iso(T0) },
          ],
        },
      },
      { match: { method: 'GET', urlIncludes: 'in-1' }, json: makeFullPayload('in-1', { category: 'Work' }) },
      { match: { method: 'GET', urlIncludes: 'out-1' }, json: makeFullPayload('out-1') },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pulled).toBe(1);
    expect(requests.filter((r) => r.url.includes('/api/notes/in-1'))).toHaveLength(1);
    // Out-of-scope payload was fetched (manifest carries no category)…
    expect(requests.filter((r) => r.url.includes('/api/notes/out-1') && r.method === 'GET')).toHaveLength(1);
    // …but NOT stored.
    const notes = await getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].category).toBe('Work');

    // Second run: the cached category hides the out-of-scope entry entirely —
    // no payload fetch, no pull, no delete-local planning.
    const { impl: impl2, requests: requests2 } = makeFetch([
      {
        match: { method: 'GET' },
        json: {
          notes: [
            { uid: 'out-1', updatedAt: iso(T0 + 999), deleted: true },
            { uid: 'in-1', updatedAt: iso(T0) },
          ],
        },
      },
      { match: { method: 'GET', urlIncludes: 'in-1' }, json: makeFullPayload('in-1', { category: 'Work' }) },
    ]);
    const result2 = await runSync({ fetchImpl: impl2 });
    expect(result2.pulled).toBe(0);
    expect(result2.deletedLocal).toBe(0);
    expect(requests2.filter((r) => r.url.includes('/api/notes/out-1'))).toHaveLength(0);
    expect(pending()).toHaveLength(0); // out of scope → silent
    expect(await getAllNotes()).toHaveLength(1);
  });

  it('skips a pull whose PAYLOAD category is out of scope (moved on another device)', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid: 'moved-1', updatedAt: iso(T0) }] } },
      // Manifest entry has no category; the payload reveals the move.
      { match: { method: 'GET', urlIncludes: 'moved-1' }, json: makeFullPayload('moved-1', { category: 'Personal' }) },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pulled).toBe(0);
    expect(await getAllNotes()).toHaveLength(0);
  });

  it('a note that moves OUT of scope keeps its copy, is not pushed, not delete-localled', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    const id = await seedNote({ title: 'Was Work', category: 'Personal', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId(SRV, id);
    // Remote still has the (older) Work version — planner would push/pull it
    // if the note were in scope.
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 - 5000) }] } },
      { match: { method: 'PUT' }, status: 204 },
      { match: { method: 'GET', urlIncludes: uid }, json: makeFullPayload(uid) },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(result.deletedLocal).toBe(0);
    expect(pending()).toHaveLength(0);
    const note = await db.notes.get(id);
    expect(note).toBeDefined();
    expect(note!.category).toBe('Personal'); // untouched
  });

  it('a note moved INTO scope syncs normally on the next run', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    const id = await seedNote({ title: 'Now Work', category: 'Work', updatedAt: new Date(T0 + 100) });
    // uid was assigned while the note was out of scope — mapping survives.
    assignUidForNoteId(SRV, id);
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);
    const result = await runSync({ fetchImpl: impl });
    expect(result.pushed).toBe(1);
    expect(requests.find((r) => r.method === 'PUT')!.body.title).toBe('Now Work');
  });

  it('ignores remote deletions of OUT-of-scope notes silently (no prompt)', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    const outId = await seedNote({ title: 'Personal note', category: 'Personal' });
    const uid = assignUidForNoteId(SRV, outId);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.deletedLocal).toBe(0);
    expect(pending()).toHaveLength(0);
    expect(await db.notes.get(outId)).toBeDefined();
  });

  it('queues a prompt for an IN-scope remote deletion and keeps the local note', async () => {
    configureServer({ syncScope: 'categories', syncedCategories: ['Work'] });
    const inId = await seedNote({ title: 'Work note', category: 'Work' });
    const uid = assignUidForNoteId(SRV, inId);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.deletedLocal).toBe(0);
    expect(await db.notes.get(inId)).toBeDefined();
    const items = pending();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ uid, title: 'Work note', category: 'Work', kind: 'remote-delete' });
  });
});

// ─── never-delete policy in runSync ──────────────────────────────────────────

describe('never-delete policy', () => {
  it('remote deleted:true + local OLDER → local note STILL PRESENT + queue entry', async () => {
    configureServer();
    const id = await seedNote({ title: 'Server deleted me', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId(SRV, id);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);

    await runSync({ fetchImpl: impl });

    // The core guarantee: db.notes.delete for remote deletions never runs.
    const note = await db.notes.get(id);
    expect(note).toBeDefined();
    expect(note!.title).toBe('Server deleted me');
    expect(getUidForNoteId(SRV, id)).toBe(uid); // mapping intact
    expect(pending()).toHaveLength(1);
  });

  it('remote deletion with local NEWER still resurrects (push) — no prompt', async () => {
    configureServer();
    const id = await seedNote({ title: 'Edited after deletion', updatedAt: new Date(T0 + 5000) });
    const uid = assignUidForNoteId(SRV, id);
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pushed).toBe(1);
    expect(requests.some((r) => r.method === 'PUT')).toBe(true);
    expect(pending()).toHaveLength(0);
  });

  it('local user deletions STILL propagate as remote tombstones (unchanged)', async () => {
    configureServer();
    recordTombstoneFor(SRV, 'user-deleted', new Date(T0 + 400), new Date(T0));
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid: 'user-deleted', updatedAt: iso(T0) }] } },
      { match: { method: 'DELETE' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.deletedRemote).toBe(1);
    expect(requests.find((r) => r.method === 'DELETE')!.url).toBe('https://sync.test/api/notes/user-deleted');
    expect(loadTombstonesFor(SRV)).toHaveLength(0);
    expect(pending()).toHaveLength(0);
  });

  it('a stale local tombstone (local deleted first) consumes as delete-remote — no prompt', async () => {
    configureServer();
    // Local deleted the note; server copy is OLDER than the deletion.
    recordTombstoneFor(SRV, 'stale-uid', new Date(T0 + 400), new Date(T0));
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid: 'stale-uid', updatedAt: iso(T0) }] } },
      { match: { method: 'DELETE' }, status: 204 },
    ]);
    const result = await runSync({ fetchImpl: impl });
    expect(result.deletedRemote).toBe(1);
    expect(pending()).toHaveLength(0);
  });

  it('the plan may still emit delete-local intents — planner stays pure and backward-compatible', () => {
    const local: LocalNoteMeta[] = [{ noteId: 1, uid: 'u1', title: 'L', updatedAt: iso(T0) }];
    const remoteMeta: RemoteNoteMeta[] = [{ uid: 'u1', updatedAt: iso(T0 + 500), deleted: true }];
    // planSync itself is UNCHANGED — it still reports the intent...
    expect(planSync(local, remoteMeta, [])).toEqual([
      { kind: 'delete-local', uid: 'u1', noteId: 1 },
    ]);
    // ...and the orchestrator converts it (covered by the runSync tests above).
  });
});

// ─── notification queue ──────────────────────────────────────────────────────

describe('syncNotifications queue', () => {
  it('enqueues with stable ids and readable fields', () => {
    const entry = enqueueRemoteDeletion({
      serverId: SRV,
      uid: 'uid-1',
      title: 'My note',
      category: 'Work',
      deletedAt: iso(T0 + 500),
    });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(`${SRV}:remote-delete:uid-1`);
    expect(pending()).toHaveLength(1);
    expect(isQueued(SRV, 'uid-1')).toBe(true);
  });

  it('dedupes: no double-queue for the same uid', () => {
    enqueueRemoteDeletion({ serverId: SRV, uid: 'uid-1', title: 'A', category: 'C', deletedAt: iso(T0) });
    const again = enqueueRemoteDeletion({ serverId: SRV, uid: 'uid-1', title: 'A', category: 'C', deletedAt: iso(T0 + 1) });
    expect(again).toBeNull();
    expect(pending()).toHaveLength(1);
  });

  it('never enqueues for a uid with a permanent exception', () => {
    addKeepException(SRV, 'kept-uid');
    const entry = enqueueRemoteDeletion({ serverId: SRV, uid: 'kept-uid', title: 'X', category: 'C', deletedAt: iso(T0) });
    expect(entry).toBeNull();
    expect(pending()).toHaveLength(0);
    expect(wouldPromptBeSuppressed(SRV, 'kept-uid')).toBe(true);
  });

  it('survives a page reload (localStorage persistence)', () => {
    enqueueRemoteDeletion({ serverId: SRV, uid: 'uid-1', title: 'A', category: 'C', deletedAt: iso(T0) });
    // Simulate reload: read again from storage (same API, new call).
    const reloaded = pending();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].uid).toBe('uid-1');
  });

  it('tolerates corrupt storage', () => {
    localStorage.setItem('notehaven.sync.notifications', '{not json');
    expect(pending()).toEqual([]);
    localStorage.setItem('notehaven.sync.keepExceptions', '[1,2]');
    expect(hasKeepException(SRV, 'x')).toBe(false);
  });
});

// ─── resolve decisions ───────────────────────────────────────────────────────

describe('resolveNotification', () => {
  it('KEEP → permanent exception, queue emptied, local note untouched, never re-prompted', async () => {
    configureServer();
    const id = await seedNote({ title: 'Kept note', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId(SRV, id);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);
    await runSync({ fetchImpl: impl });
    expect(pending()).toHaveLength(1);

    await resolveNotification(`${SRV}:remote-delete:${uid}`, 'keep');

    expect(pending()).toHaveLength(0);
    expect(hasKeepException(SRV, uid)).toBe(true);
    expect(await db.notes.get(id)).toBeDefined(); // untouched

    // Next sync with the same remote tombstone: no re-prompt, no delete.
    const { impl: impl2 } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);
    await runSync({ fetchImpl: impl2 });
    expect(pending()).toHaveLength(0);
    expect(await db.notes.get(id)).toBeDefined();
  });

  it('DELETE → local note removed, no re-prompt on next sync', async () => {
    configureServer();
    const id = await seedNote({ title: 'Delete me', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId(SRV, id);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);
    await runSync({ fetchImpl: impl });

    await resolveNotification(`${SRV}:remote-delete:${uid}`, 'delete');

    expect(await db.notes.get(id)).toBeUndefined(); // gone at the user's command
    expect(getUidForNoteId(SRV, id)).toBeNull(); // mapping forgotten
    expect(pending()).toHaveLength(0);
    // No exception was created (delete is a one-time decision).
    expect(hasKeepException(SRV, uid)).toBe(false);

    // Next sync sees the same tombstone: note is gone locally, uid unmapped —
    // nothing to prompt about (remote-only deleted entries are ignored).
    const { impl: impl2 } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);
    await runSync({ fetchImpl: impl2 });
    expect(pending()).toHaveLength(0);
  });

  it('KEEP + remote resurrection → the note pulls normally (exception ≠ pull suppression)', async () => {
    configureServer();
    const id = await seedNote({ title: 'Kept then resurrected', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId(SRV, id);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 500), deleted: true }] } },
    ]);
    await runSync({ fetchImpl: impl });
    await resolveNotification(`${SRV}:remote-delete:${uid}`, 'keep');

    // Server resurrects (PUT again, deleted flag cleared) with a NEWER update.
    const { impl: impl2 } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [{ uid, updatedAt: iso(T0 + 9000) }] } },
      {
        match: { method: 'GET', urlIncludes: uid },
        json: makeFullPayload(uid, { title: 'Resurrected', updatedAt: iso(T0 + 9000) }),
      },
    ]);
    const result = await runSync({ fetchImpl: impl2 });
    expect(result.pulled).toBe(1);
    const note = await db.notes.get(id);
    expect(note!.title).toBe('Resurrected');
  });

  it('DELETE on a note that no longer exists locally is a no-op that still clears the queue', async () => {
    configureServer(); // the entry must live in a CONFIGURED server's queue
    enqueueRemoteDeletion({ serverId: SRV, uid: 'ghost-uid', title: 'Ghost', category: 'C', deletedAt: iso(T0) });
    await resolveNotification(`${SRV}:remote-delete:ghost-uid`, 'delete');
    expect(pending()).toHaveLength(0);
  });

  it('deleteNoteForUid removes revisions and the uid mapping', async () => {
    const id = await seedNote({ title: 'With revisions' });
    const uid = assignUidForNoteId(SRV, id);
    await db.revisions.add({ noteId: id, title: 'old', content: '', tags: [], category: 'General', savedAt: new Date() });
    expect(await deleteNoteForUid(SRV, uid)).toBe(true);
    expect(await db.notes.get(id)).toBeUndefined();
    expect(getUidForNoteId(SRV, id)).toBeNull();
    expect(await db.revisions.where('noteId').equals(id).count()).toBe(0);
  });

  it('unknown ids and empty resolves are safe', async () => {
    await resolveNotification(`${SRV}:remote-delete:missing`, 'keep');
    expect(getKeepExceptionUids(SRV)).toEqual([]);
    await resolveNotification(`${SRV}:remote-delete:x`, 'delete');
    expect(pending()).toHaveLength(0);
  });

  it('exception timestamps are recorded per uid', () => {
    addKeepException(SRV, 'a');
    addKeepException(SRV, 'b');
    expect(getKeepExceptionUids(SRV)).toEqual(['a', 'b']);
    expect(hasKeepException(SRV, 'a')).toBe(true);
    expect(hasKeepException(SRV, 'c')).toBe(false);
  });
});

// ─── planSync purity spot-check (backward compatibility) ─────────────────────

describe('planSync (unchanged semantics)', () => {
  it('still emits push/pull/delete-local/delete-remote intents', () => {
    const ops = planSync(
      [
        { noteId: 1, uid: 'u1', title: 'L1', updatedAt: iso(T0 + 100), category: 'Work' },
        { noteId: 2, uid: 'u2', title: 'L2', updatedAt: iso(T0) },
      ],
      [
        { uid: 'u1', updatedAt: iso(T0) },
        { uid: 'u2', updatedAt: iso(T0 + 900), deleted: true },
      ],
      [],
    );
    expect(ops).toEqual([
      { kind: 'push', uid: 'u1', noteId: 1 },
      { kind: 'delete-local', uid: 'u2', noteId: 2 },
    ]);
  });
});