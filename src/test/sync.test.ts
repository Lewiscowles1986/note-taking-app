/**
 * Unit tests for the sync engine (src/lib/sync.ts).
 *
 * The merge planner (planSync) is pure and tested over plain data. The
 * orchestrator (runSync) is exercised against a stubbed fetch + the real Dexie
 * database (fake-indexeddb, wiped per test), covering push/pull/both-delete
 * flows, tombstone bookkeeping, uid mapping, and error handling.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, createNote, detectContentFeatures, getAllNotes, type Note } from '@/lib/db';
import {
  planSync,
  runSync,
  SyncError,
  buildSyncPayload,
  payloadToNote,
  parseManifest,
  getUidForNoteId,
  assignUidForNoteId,
  pruneUidMap,
  type LocalNoteMeta,
  type RemoteNoteMeta,
} from '@/lib/sync';
import {
  getServerSettings,
  saveServerSettings,
  listServers,
  addServer,
} from '@/lib/syncServers';
import { recordTombstoneFor, loadTombstonesFor } from '@/lib/syncSettings';
import { getPendingNotifications } from '@/lib/syncNotifications';

// ─── helpers ─────────────────────────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

/** Fixed epoch so relative-time logic is deterministic. Kept near `now` so
 * tombstone TTL pruning (90 days) never interferes with test fixtures. */
const T0 = Date.now();

const local = (noteId: number, uid: string, updatedAtMs: number, title = 'L'): LocalNoteMeta => ({
  noteId,
  uid,
  title,
  updatedAt: iso(updatedAtMs),
});

const remote = (uid: string, updatedAtMs: number, deleted = false): RemoteNoteMeta => ({
  uid,
  updatedAt: iso(updatedAtMs),
  deleted,
});

/** Wipe the real database and reopen it fresh at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

/** Fresh localStorage slice for settings + tombstones + uid map. */
function resetStorage(): void {
  localStorage.clear();
}

/** Build a note directly in Dexie with a pinned updatedAt, feature flags
 * computed exactly as createNote does for real notes. */
async function seedNote(overrides: Partial<Note> = {}): Promise<number> {
  const now = new Date(T0);
  const content = overrides.content ?? 'body';
  const id = await db.notes.add({
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
  return id;
}

interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

/**
 * Scriptable fetch stub: records every request, answers from a queue of
 * handlers (or a default 200 with JSON body), and can simulate network
 * failures per URL substring. Handlers match most-specific first (longest
 * urlIncludes wins), so a "/api/notes/<uid>" handler outranks "/api/notes".
 */
function makeFetch(handlers: Array<{
  match: { method?: string; urlIncludes?: string };
  status?: number;
  json?: unknown;
  text?: string;
  networkError?: boolean;
}> = []) {
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
    if (!handler) {
      throw new Error(`unexpected fetch in test stub: ${method} ${url}`);
    }
    if (handler.networkError) throw new TypeError('network down');
    const status = handler.status ?? 200;
    // 204/205/304 are null-body statuses: Response construction with a body
    // (even '') throws TypeError, so build those from null.
    const payload =
      status === 204 || status === 205 || status === 304
        ? null
        : (handler.text ?? (handler.json !== undefined ? JSON.stringify(handler.json) : ''));
    return new Response(payload, { status });
  };
  return { impl: impl as unknown as typeof fetch, requests };
}

/** Configure ONE test server (id = URL) with a token. Returns the server id. */
function configureServer(url = 'https://sync.test', overrides: Record<string, unknown> = {}): string {
  addServer(url);
  saveServerSettings(url, {
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
  return url;
}

beforeEach(async () => {
  await resetDb();
  resetStorage();
});

// ─── planSync (pure planner) ─────────────────────────────────────────────────

describe('planSync', () => {
  it('pushes local-only notes that have no tombstone', () => {
    const ops = planSync([local(1, 'u1', T0)], [], []);
    expect(ops).toEqual([{ kind: 'push', uid: 'u1', noteId: 1 }]);
  });

  it('propagates pending deletions via tombstones even though the note is gone locally', () => {
    const tombstones: Tombstone[] = [
      { uid: 'u9', deletedAt: iso(T0 + 500), noteUpdatedAt: iso(T0) },
    ];
    // Note u9 no longer appears in `local` — the tombstone drives the plan.
    const ops = planSync([], [remote('u9', T0)], tombstones);
    expect(ops).toEqual([{ kind: 'delete-remote', uid: 'u9' }]);
  });

  it('pulls (resurrects) a tombstoned note that was edited on the server after the deletion', () => {
    const tombstones: Tombstone[] = [
      { uid: 'u9', deletedAt: iso(T0 + 500), noteUpdatedAt: iso(T0) },
    ];
    const ops = planSync([], [remote('u9', T0 + 1000)], tombstones);
    expect(ops).toEqual([{ kind: 'pull', uid: 'u9', noteId: null }]);
  });

  it('does not delete a live local note just because a stale tombstone exists', () => {
    const tombstones: Tombstone[] = [
      { uid: 'u1', deletedAt: iso(T0 + 500), noteUpdatedAt: iso(T0) },
    ];
    const ops = planSync([local(1, 'u1', T0 + 900)], [], tombstones);
    expect(ops).toEqual([{ kind: 'push', uid: 'u1', noteId: 1 }]);
  });

  it('pulls remote-only notes', () => {
    const ops = planSync([], [remote('u2', T0)], []);
    expect(ops).toEqual([{ kind: 'pull', uid: 'u2', noteId: null }]);
  });

  it('ignores remote-only deleted manifests', () => {
    const ops = planSync([], [remote('u3', T0, true)], []);
    expect(ops).toEqual([]);
  });

  it('pushes when local is newer, pulls when remote is newer, no-op on equality', () => {
    const ops = planSync(
      [local(1, 'u1', T0 + 100), local(2, 'u2', T0), local(3, 'u3', T0 + 5)],
      [remote('u1', T0), remote('u2', T0 + 100), remote('u3', T0 + 5)],
      [],
    );
    expect(ops).toEqual([
      { kind: 'push', uid: 'u1', noteId: 1 },
      { kind: 'pull', uid: 'u2', noteId: 2 },
    ]);
  });

  it('resurrects a locally-edited note after a remote deletion, else deletes local', () => {
    const ops = planSync(
      [local(1, 'u1', T0 + 1000), local(2, 'u2', T0)],
      [remote('u1', T0 + 500, true), remote('u2', T0 + 500, true)],
      [],
    );
    expect(ops).toEqual([
      { kind: 'push', uid: 'u1', noteId: 1 },
      { kind: 'delete-local', uid: 'u2', noteId: 2 },
    ]);
  });

  it('handles an empty world as a no-op', () => {
    expect(planSync([], [], [])).toEqual([]);
  });
});

// ─── payload shape round-trip ────────────────────────────────────────────────

describe('payload shape', () => {
  it('round-trips a note through buildSyncPayload → payloadToNote', async () => {
    const id = await seedNote({
      title: 'Round trip',
      content: '# Hello\n\n```mermaid\ngraph TD\nA-->B\n```',
      tags: ['a', 'b'],
      category: 'Work',
      pinned: true,
    });
    const note = (await getAllNotes()).find((n) => n.id === id)!;
    const uid = 'uid-rt';
    const payload = buildSyncPayload(note, uid);

    expect(payload.uid).toBe(uid);
    expect(payload.title).toBe('Round trip');
    expect(payload.updatedAt).toBe(iso(T0));
    expect(payload.hasMermaid).toBe(true);
    expect(payload.encrypted).toBeNull();

    const restored = payloadToNote(payload);
    expect(restored.title).toBe('Round trip');
    expect(restored.content).toBe(note.content);
    expect(restored.tags).toEqual(['a', 'b']);
    expect(restored.category).toBe('Work');
    expect(restored.pinned).toBe(true);
    expect(restored.createdAt.getTime()).toBe(T0);
    expect(restored.updatedAt.getTime()).toBe(T0);
  });

  it('payloadToNote defends against malformed payloads', () => {
    const note = payloadToNote({
      uid: 'x',
      title: undefined as unknown as string,
      content: undefined as unknown as string,
      tags: 'nope' as unknown as string[],
      category: undefined as unknown as string,
      attachments: null as unknown as Note['attachments'],
      createdAt: 'not-a-date',
      updatedAt: 42 as unknown as string,
      editDates: undefined as unknown as string[],
      pinned: 1 as unknown as boolean,
    });
    expect(note.title).toBe('Untitled');
    expect(note.content).toBe('');
    expect(note.tags).toEqual([]);
    expect(note.category).toBe('General');
    expect(note.attachments).toEqual([]);
    expect(note.createdAt.getTime()).not.toBeNaN();
    expect(note.editDates.length).toBeGreaterThan(0);
    expect(note.pinned).toBe(false);
  });

  it('preserves encrypted payloads verbatim (no plaintext handling in transport)', async () => {
    const id = await seedNote({
      content: '[encrypted]',
      encrypted: {
        method: 'password',
        ciphertext: 'AbCd',
        iv: 'IvIv',
        salt: 'SaSa',
        mac: 'MaMa',
      },
    });
    const note = (await getAllNotes()).find((n) => n.id === id)!;
    const payload = buildSyncPayload(note, 'uid-enc');
    expect(payload.encrypted).toEqual(note.encrypted);
    const restored = payloadToNote(payload);
    expect(restored.encrypted).toEqual(note.encrypted);
    expect(restored.content).toBe('[encrypted]');
  });
});

// ─── manifest parsing ────────────────────────────────────────────────────────

describe('parseManifest', () => {
  it('accepts { notes: [...] } and bare arrays, filters malformed entries', () => {
    const wrapped = parseManifest({
      notes: [
        { uid: 'a', updatedAt: iso(T0) },
        { uid: 5, updatedAt: iso(T0) },
        'junk',
        { uid: 'b', updatedAt: 'nope' },
        { uid: 'c', updatedAt: iso(T0 + 1), deleted: true },
      ],
    });
    expect(wrapped).toEqual([
      { uid: 'a', updatedAt: iso(T0), deleted: false },
      { uid: 'c', updatedAt: iso(T0 + 1), deleted: true },
    ]);

    const bare = parseManifest([{ uid: 'z', updatedAt: iso(T0) }]);
    expect(bare).toHaveLength(1);
  });

  it('rejects non-manifest shapes', () => {
    expect(() => parseManifest({ nope: true })).toThrow(SyncError);
    expect(() => parseManifest('nope')).toThrow(SyncError);
  });
});

// ─── uid mapping ─────────────────────────────────────────────────────────────

describe('uid mapping (per server)', () => {
  it('assigns once and returns the same uid — PER SERVER', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    const first = assignUidForNoteId('https://a.dev', 42);
    expect(assignUidForNoteId('https://a.dev', 42)).toBe(first);
    expect(getUidForNoteId('https://a.dev', 42)).toBe(first);
  });

  it('the same note gets DIFFERENT uids on different servers', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    const uidA = assignUidForNoteId('https://a.dev', 42);
    const uidB = assignUidForNoteId('https://b.dev', 42);
    expect(uidA).not.toBe(uidB);
    expect(getUidForNoteId('https://b.dev', 42)).toBe(uidB);
  });

  it('prunes mappings for notes that no longer exist (per server)', () => {
    addServer('https://a.dev');
    assignUidForNoteId('https://a.dev', 1);
    assignUidForNoteId('https://a.dev', 2);
    pruneUidMap('https://a.dev', [2]);
    expect(getUidForNoteId('https://a.dev', 1)).toBeNull();
    expect(getUidForNoteId('https://a.dev', 2)).not.toBeNull();
  });
});

// ─── runSync (orchestrator) ──────────────────────────────────────────────────

describe('runSync', () => {
  it('is callable with no arguments (all-servers path)', async () => {
    // Regression: the settings page calls runSync() bare; the options
    // parameter must default to {} instead of throwing on undefined.
    await expect(runSync()).rejects.toThrow(SyncError);
  });

  it('throws SyncError when no server is configured', async () => {
    await expect(runSync({ fetchImpl: makeFetch().impl })).rejects.toThrow(SyncError);
  });

  it('pushes a local note to the server with auth header', async () => {
    configureServer();
    const id = await seedNote({ title: 'Local only', updatedAt: new Date(T0) });
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });

    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(1);
    const put = requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe(`https://sync.test/api/notes/${getUidForNoteId('https://sync.test', id)}`);
    expect(put.headers.authorization).toBe('Bearer secret-token');
    expect(put.body.title).toBe('Local only');
    // Outcome recorded for the servers page status line.
    expect(getServerSettings('https://sync.test').lastSync?.ok).toBe(true);
  });

  it('pulls a remote-only note into the database and maps its uid', async () => {
    configureServer();
    const payload = {
      uid: 'remote-1',
      title: 'From server',
      content: '# From server',
      tags: ['synced'],
      category: 'General',
      attachments: [],
      createdAt: iso(T0 - 1000),
      updatedAt: iso(T0),
      editDates: ['2026-01-01'],
      pinned: false,
      encrypted: null,
    };
    const { impl } = makeFetch([
      { match: { method: 'GET', urlIncludes: '/api/notes/remote-1' }, json: payload },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [remote('remote-1', T0)] } },
    ]);

    const result = await runSync({ fetchImpl: impl });

    expect(result.ok).toBe(true);
    expect(result.pulled).toBe(1);
    const notes = await getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('From server');
    expect(notes[0].tags).toEqual(['synced']);
    expect(notes[0].updatedAt.getTime()).toBe(T0);
    expect(getUidForNoteId('https://sync.test', notes[0].id!)).toBe('remote-1');
  });

  it('pulls an update over an older local copy of the same uid', async () => {
    configureServer();
    const id = await seedNote({ title: 'Older local', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId('https://sync.test', id);
    const { impl } = makeFetch([
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [remote(uid, T0 + 999)] } },
      {
        match: { method: 'GET', urlIncludes: `/api/notes/${uid}` },
        json: {
          uid,
          title: 'Newer remote',
          content: 'updated body',
          tags: [],
          category: 'General',
          attachments: [],
          createdAt: iso(T0 - 1000),
          updatedAt: iso(T0 + 999),
          editDates: ['2026-01-01'],
          pinned: false,
          encrypted: null,
        },
      },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pulled).toBe(1);
    const note = await db.notes.get(id);
    expect(note!.title).toBe('Newer remote');
  });

  it('pushes an update over an older remote copy', async () => {
    configureServer();
    const id = await seedNote({ title: 'Newer local', updatedAt: new Date(T0 + 999) });
    const uid = assignUidForNoteId('https://sync.test', id);
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [remote(uid, T0)] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.pushed).toBe(1);
    expect(requests.find((r) => r.method === 'PUT')!.body.title).toBe('Newer local');
  });

  it('NEVER deletes the local note for a remote tombstone — queues a prompt instead', async () => {
    configureServer();
    const id = await seedNote({ title: 'Doomed', updatedAt: new Date(T0) });
    const uid = assignUidForNoteId('https://sync.test', id);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [remote(uid, T0 + 500, true)] } },
    ]);

    const result = await runSync({ fetchImpl: impl });
    // Nothing was removed locally…
    expect(result.deletedLocal).toBe(0);
    const stillThere = await db.notes.get(id);
    expect(stillThere).toBeDefined();
    expect(stillThere!.title).toBe('Doomed');
    // …and the deletion is queued for the user's keep-or-delete choice.
    expect(getPendingNotifications('https://sync.test')).toHaveLength(1);
    expect(getPendingNotifications('https://sync.test')[0]).toMatchObject({
      serverId: 'https://sync.test',
      uid,
      title: 'Doomed',
      kind: 'remote-delete',
    });
    // The user's own deletions still propagate: no local tombstone was recorded.
    expect(loadTombstonesFor('https://sync.test')).toHaveLength(0);
  });

  it('propagates a local deletion to the server and clears the tombstone', async () => {
    configureServer();
    recordTombstoneFor('https://sync.test', 'gone-uid', new Date(T0 + 400), new Date(T0));
    const { impl, requests } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [remote('gone-uid', T0)] } },
      { match: { method: 'DELETE' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.deletedRemote).toBe(1);
    expect(requests.find((r) => r.method === 'DELETE')!.url).toBe('https://sync.test/api/notes/gone-uid');
    expect(loadTombstonesFor('https://sync.test')).toHaveLength(0);
    expect(getServerSettings('https://sync.test').lastSync?.ok).toBe(true);
  });

  it('keeps the tombstone when the server delete fails, and reports partial failure', async () => {
    configureServer();
    recordTombstoneFor('https://sync.test', 'gone-uid', new Date(T0 + 400), new Date(T0));
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [remote('gone-uid', T0)] } },
      { match: { method: 'DELETE' }, status: 500 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(loadTombstonesFor('https://sync.test')).toHaveLength(1);
  });

  it('collects per-op errors and keeps going, surfacing a failed lastSync', async () => {
    configureServer();
    const okId = await seedNote({ title: 'Will push fine', updatedAt: new Date(T0) });
    assignUidForNoteId('https://sync.test', okId);
    const badId = await seedNote({ title: 'Will fail', updatedAt: new Date(T0) });
    const badUid = assignUidForNoteId('https://sync.test', badId);
    const { impl } = makeFetch([
      { match: { method: 'GET' }, json: { notes: [remote(badUid, T0 - 500)] } },
      { match: { method: 'PUT', urlIncludes: badUid }, status: 500 },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(getServerSettings('https://sync.test').lastSync?.ok).toBe(false);
  });

  it('folds a fatal network failure into ok:false and records a failed lastSync', async () => {
    configureServer();
    const { impl } = makeFetch([{ match: { method: 'GET' }, networkError: true }]);
    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/network error/);
    const lastSync = getServerSettings('https://sync.test').lastSync;
    expect(lastSync?.ok).toBe(false);
    expect(lastSync?.summary).toMatch(/network error/);
  });

  it('folds a fatal non-2xx manifest response into ok:false', async () => {
    configureServer();
    const { impl } = makeFetch([{ match: { method: 'GET' }, status: 401 }]);
    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/401/);
  });

  it('folds a fatal invalid-JSON body into ok:false', async () => {
    configureServer();
    const { impl } = makeFetch([{ match: { method: 'GET' }, text: 'not json' }]);
    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/invalid JSON/);
  });

  it('honors an already-aborted signal without touching the network (folded, not rethrown)', async () => {
    configureServer();
    const { impl, requests } = makeFetch([]);
    const controller = new AbortController();
    controller.abort();
    // DOMException message is "Aborted" — folded into ok:false, nothing fetched.
    const result = await runSync({ fetchImpl: impl, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('Aborted');
    expect(requests).toHaveLength(0);
  });

  it('scope widening repatriates an out-of-scope remote note (uidMap + category cache retained)', async () => {
    configureServer('https://sync.test', { syncScope: 'categories', syncedCategories: ['Work'] });
    const payload = {
      uid: 'remote-out-of-scope',
      title: 'Personal note',
      content: 'private body',
      tags: [],
      category: 'Personal', // NOT in scope
      attachments: [],
      createdAt: iso(T0 - 1000),
      updatedAt: iso(T0),
      editDates: ['2026-01-01'],
      pinned: false,
      encrypted: null,
    };

    // Round 1: scope = [Work]. The note is fetched once (unknown uid), found
    // out-of-scope on its payload, cached, and NOT stored.
    const round1 = makeFetch([
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [remote('remote-out-of-scope', T0)] } },
      { match: { method: 'GET', urlIncludes: '/api/notes/remote-out-of-scope' }, json: payload },
    ]);
    const r1 = await runSync({ fetchImpl: round1.impl });
    expect(r1.ok).toBe(true);
    expect(r1.pulled).toBe(0);
    expect(await getAllNotes()).toHaveLength(0);
    // The out-of-scope category is cached for the uid (per-server key).
    expect(JSON.parse(localStorage.getItem('notehaven.sync.remoteCategories.https://sync.test')!)).toMatchObject({
      'remote-out-of-scope': 'Personal',
    });

    // Round 2 (still [Work]): the cached category short-circuits the pull —
    // the note payload is not even fetched again.
    const round2 = makeFetch([
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [remote('remote-out-of-scope', T0)] } },
      { match: { method: 'GET', urlIncludes: '/api/notes/remote-out-of-scope' }, json: payload },
    ]);
    const r2 = await runSync({ fetchImpl: round2.impl });
    expect(r2.pulled).toBe(0);
    expect(round2.requests.some((r) => r.url.includes('/api/notes/remote-out-of-scope'))).toBe(false);

    // Round 3: the user WIDENS the scope to include Personal. The note must
    // now be pulled in (uidMap retention is not even needed for a remote-only
    // note — the category cache must NOT pin it out-of-scope forever).
    saveServerSettings('https://sync.test', {
      ...getServerSettings('https://sync.test'),
      syncScope: 'categories',
      syncedCategories: ['Work', 'Personal'],
    });
    const round3 = makeFetch([
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [remote('remote-out-of-scope', T0)] } },
      { match: { method: 'GET', urlIncludes: '/api/notes/remote-out-of-scope' }, json: payload },
    ]);
    const r3 = await runSync({ fetchImpl: round3.impl });
    expect(r3.ok).toBe(true);
    expect(r3.pulled).toBe(1);
    const notes = await getAllNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Personal note');
    expect(notes[0].category).toBe('Personal');
    expect(getUidForNoteId('https://sync.test', notes[0].id!)).toBe('remote-out-of-scope');
  });

  it('a local note edited while out of scope pushes once the scope includes its category again (uidMap retained)', async () => {
    configureServer('https://sync.test', { syncScope: 'categories', syncedCategories: ['Work'] });
    const id = await seedNote({ title: 'Moved note', category: 'Personal', updatedAt: new Date(T0) });

    // Round 1: out of scope → never pushed, but keeps its uid mapping.
    const round1 = makeFetch([{ match: { method: 'GET' }, json: { notes: [] } }]);
    const r1 = await runSync({ fetchImpl: round1.impl });
    expect(r1.pushed).toBe(0);
    expect(getUidForNoteId('https://sync.test', id)).toBeTruthy();

    // Round 2: scope widened → the SAME uid pushes (mapping was retained).
    saveServerSettings('https://sync.test', {
      ...getServerSettings('https://sync.test'),
      syncScope: 'categories',
      syncedCategories: ['Work', 'Personal'],
    });
    const round2 = makeFetch([
      { match: { method: 'GET' }, json: { notes: [] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);
    const r2 = await runSync({ fetchImpl: round2.impl });
    expect(r2.pushed).toBe(1);
    const put = round2.requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe(`https://sync.test/api/notes/${getUidForNoteId('https://sync.test', id)}`);
  });

  it('TWO servers: the same note syncs to BOTH with independent uids, tombstones and notifications', async () => {
    configureServer('https://alpha.test', { authToken: 'tok-a' });
    configureServer('https://beta.test', { authToken: 'tok-b' });
    const id = await seedNote({ title: 'Both servers', updatedAt: new Date(T0) });
    const { impl, requests } = makeFetch([
      { match: { method: 'GET', urlIncludes: 'alpha.test' }, json: { notes: [] } },
      { match: { method: 'GET', urlIncludes: 'beta.test' }, json: { notes: [] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(true);
    // One note pushed to EACH server (aggregate sums both).
    expect(result.pushed).toBe(2);
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect(requests.filter((r) => r.url.includes('alpha.test') && r.method === 'PUT')).toHaveLength(1);
    expect(requests.filter((r) => r.url.includes('beta.test') && r.method === 'PUT')).toHaveLength(1);
    expect(requests.filter((r) => r.url.includes('alpha.test') && r.method === 'PUT')[0].body.title).toBe('Both servers');

    // Independent uid maps: different uids on each server.
    const uidA = getUidForNoteId('https://alpha.test', id);
    const uidB = getUidForNoteId('https://beta.test', id);
    expect(uidA).toBeTruthy();
    expect(uidB).toBeTruthy();
    expect(uidA).not.toBe(uidB);

    // Per-server lastSync recorded independently.
    expect(getServerSettings('https://alpha.test').lastSync?.ok).toBe(true);
    expect(getServerSettings('https://beta.test').lastSync?.ok).toBe(true);
  });

  it('TWO servers: a tombstone on server A does NOT affect server B', async () => {
    configureServer('https://alpha.test');
    configureServer('https://beta.test');
    // Tombstone recorded only on alpha.
    recordTombstoneFor('https://alpha.test', 'gone-uid', new Date(T0 + 400), new Date(T0));
    const { impl } = makeFetch([
      { match: { method: 'GET', urlIncludes: 'alpha.test' }, json: { notes: [remote('gone-uid', T0)] } },
      { match: { method: 'GET', urlIncludes: 'beta.test' }, json: { notes: [] } },
      { match: { method: 'DELETE' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.ok).toBe(true);
    // Only alpha propagated the deletion.
    expect(result.deletedRemote).toBe(1);
    expect(loadTombstonesFor('https://alpha.test')).toHaveLength(0);
    expect(getServerSettings('https://alpha.test').lastSync?.summary).toContain('deleted on server');
    // Beta saw an empty manifest and stayed untouched.
    expect(getServerSettings('https://beta.test').lastSync?.summary).toBe('already up to date');
  });

  it('TWO servers: a remote deletion queues a prompt attributed to the right server', async () => {
    configureServer('https://alpha.test');
    configureServer('https://beta.test');
    const id = await seedNote({ title: 'Doomed on beta', updatedAt: new Date(T0) });
    const uidB = assignUidForNoteId('https://beta.test', id);
    const { impl } = makeFetch([
      { match: { method: 'GET', urlIncludes: 'alpha.test' }, json: { notes: [] } },
      { match: { method: 'GET', urlIncludes: 'beta.test' }, json: { notes: [remote(uidB, T0 + 500, true)] } },
    ]);

    const result = await runSync({ fetchImpl: impl });
    expect(result.deletedLocal).toBe(0); // never-delete
    // ONE prompt, attributed to beta.
    const alphaQueue = getPendingNotifications('https://alpha.test');
    const betaQueue = getPendingNotifications('https://beta.test');
    expect(alphaQueue).toHaveLength(0);
    expect(betaQueue).toHaveLength(1);
    expect(betaQueue[0]).toMatchObject({ serverId: 'https://beta.test', uid: uidB, title: 'Doomed on beta' });
    // The entry id carries the server (dedupe + resolution stay per server).
    expect(betaQueue[0].id.startsWith('https://beta.test:remote-delete:')).toBe(true);
    expect(await db.notes.get(id)).toBeDefined(); // never-delete held
  });

  it('runSync({serverId}) syncs ONLY that server', async () => {
    configureServer('https://alpha.test');
    configureServer('https://beta.test');
    const id = await seedNote({ title: 'One only', updatedAt: new Date(T0) });
    const { impl, requests } = makeFetch([
      { match: { method: 'GET', urlIncludes: 'alpha.test' }, json: { notes: [] } },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ serverId: 'https://alpha.test', fetchImpl: impl });
    expect(result.pushed).toBe(1);
    expect(requests.some((r) => r.url.includes('beta.test'))).toBe(false);
    expect(getServerSettings('https://beta.test').lastSync).toBeNull();
    expect(getUidForNoteId('https://alpha.test', id)).toBeTruthy();
    expect(getUidForNoteId('https://beta.test', id)).toBeNull();
  });

  it('TWO servers, one dead: survivors keep their counts, the rejection folds into ok:false', async () => {
    configureServer('https://alpha.test', { authToken: 'tok-a' });
    configureServer('https://beta.test', { authToken: 'tok-b' });
    const id = await seedNote({ title: 'Survivor', updatedAt: new Date(T0) });
    const { impl, requests } = makeFetch([
      { match: { method: 'GET', urlIncludes: 'alpha.test' }, json: { notes: [] } },
      // beta is dead: discovery AND manifest fail with a network error.
      { match: { method: 'GET', urlIncludes: 'beta.test' }, networkError: true },
      { match: { method: 'PUT' }, status: 204 },
    ]);

    const result = await runSync({ fetchImpl: impl });

    expect(result.ok).toBe(false);
    // Beta's rejection folded in as a labelled line (aggregate not lost).
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].startsWith('[https://beta.test]')).toBe(true);
    expect(result.errors[0]).toMatch(/network error/);
    // Alpha's work is preserved and counted.
    expect(result.pushed).toBe(1);
    expect(requests.filter((r) => r.url.includes('alpha.test') && r.method === 'PUT')).toHaveLength(1);
    expect(getUidForNoteId('https://alpha.test', id)).toBeTruthy();
    // Per-server lastSync: alpha ok, beta failed with the error in its summary.
    expect(getServerSettings('https://alpha.test').lastSync?.ok).toBe(true);
    expect(getServerSettings('https://beta.test').lastSync?.ok).toBe(false);
    expect(getServerSettings('https://beta.test').lastSync?.summary).toMatch(/network error/);
    // The combined summary still carries BOTH servers' lines (alpha's count
    // and beta's fatal error), joined by ' · '.
    expect(result.summary).toContain('1 pushed');
    expect(result.summary).toMatch(/network error/);
    expect(result.summary).toContain(' · ');
  });

  it('a fatal sync failure records a failed lastSync, then rethrows (single-server path)', async () => {
    configureServer();
    const { impl } = makeFetch([{ match: { method: 'GET' }, networkError: true }]);
    await expect(runSync({ serverId: 'https://sync.test', fetchImpl: impl })).rejects.toThrow(/network error/);
    const lastSync = getServerSettings('https://sync.test').lastSync;
    expect(lastSync?.ok).toBe(false);
    expect(lastSync?.summary).toMatch(/network error/);
    expect(Number.isFinite(Date.parse(lastSync!.at))).toBe(true);
  });
});

// ─── deletion hook (now lives in syncDeletion.ts; see syncScheduler.test.tsx) ─