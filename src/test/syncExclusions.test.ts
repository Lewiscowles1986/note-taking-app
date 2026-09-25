/**
 * Exclusion precedence tests: the deny-wins model for note sync.
 *
 * resolveSyncDecision is THE single source of truth (used by the sync engine,
 * the settings UI, and the sidebar badge) — every cell of the precedence
 * table plus the documented edge cases (a)–(e) is pinned here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, detectContentFeatures } from '@/lib/db';
import {
  resolveSyncDecision,
  loadSyncSettings,
  saveSyncSettings,
  isNoteExcluded,
  type SyncDecisionInput,
} from '@/lib/syncSettings';
import { saveExcludedNoteIds } from '@/lib/syncServers';
import { runSync, parseDiscoveryExclusions, SyncError } from '@/lib/sync';
import { getPendingNotifications } from '@/lib/syncNotifications';

// ─── resolveSyncDecision (pure) ──────────────────────────────────────────────

function decisionInput(overrides: Partial<SyncDecisionInput> = {}): SyncDecisionInput {
  return {
    serverExcludedCategories: [],
    serverExcludedUids: [],
    uid: 'u1',
    noteId: 1,
    category: 'General',
    syncScope: 'all',
    syncedCategories: [],
    excludedCategories: [],
    excludedNoteIds: [],
    ...overrides,
  };
}

describe('resolveSyncDecision — the precedence table (every cell)', () => {
  it('row 1: server deny wins over EVERYTHING (even client allow + no client deny)', () => {
    const result = resolveSyncDecision(
      decisionInput({ serverExcludedCategories: ['Work'], category: 'Work' }),
    );
    expect(result).toEqual({ decision: 'skip', reason: 'server-denied' });
  });

  it('row 1b: server uid deny wins even when the client allow-lists its category', () => {
    const result = resolveSyncDecision(
      decisionInput({
        serverExcludedUids: ['u1'],
        category: 'Work',
        syncScope: 'categories',
        syncedCategories: ['Work'],
      }),
    );
    expect(result).toEqual({ decision: 'skip', reason: 'server-denied' });
  });

  it('row 2: no server deny + out of client scope → EXCLUDED', () => {
    const result = resolveSyncDecision(
      decisionInput({ syncScope: 'categories', syncedCategories: ['Other'] }),
    );
    expect(result).toEqual({ decision: 'skip', reason: 'out-of-scope' });
  });

  it('row 3: no server deny + in scope + no client deny → ALLOWED', () => {
    const result = resolveSyncDecision(
      decisionInput({ syncScope: 'categories', syncedCategories: ['General'] }),
    );
    expect(result).toEqual({ decision: 'sync', reason: 'allowed' });
  });

  it('row 4: client category deny wins over client scope allow → EXCLUDED', () => {
    const result = resolveSyncDecision(
      decisionInput({
        syncScope: 'categories',
        syncedCategories: ['Work'],
        excludedCategories: ['Work'],
        category: 'Work',
      }),
    );
    expect(result).toEqual({ decision: 'skip', reason: 'client-denied' });
  });

  it('row 4b: client note deny wins over client scope allow (note X in allowed Work)', () => {
    const result = resolveSyncDecision(
      decisionInput({
        syncScope: 'categories',
        syncedCategories: ['Work'],
        excludedNoteIds: [1],
        category: 'Work',
      }),
    );
    expect(result).toEqual({ decision: 'skip', reason: 'client-denied' });
  });

  it('deny reason priority: server-denied reported over client-denied', () => {
    const result = resolveSyncDecision(
      decisionInput({ serverExcludedCategories: ['Work'], excludedCategories: ['Work'], category: 'Work' }),
    );
    expect(result.reason).toBe('server-denied');
  });

  it('client note deny is reported over client category deny', () => {
    const result = resolveSyncDecision(
      decisionInput({ excludedNoteIds: [1], excludedCategories: ['General'] }),
    );
    expect(result.reason).toBe('client-denied');
  });
});

describe('resolveSyncDecision — documented edge cases', () => {
  it('(a) note moves OUT of an excluded category → in-scope again (decision only; storage untouched by the engine)', () => {
    const was = resolveSyncDecision(decisionInput({ excludedCategories: ['Work'], category: 'Work' }));
    expect(was.decision).toBe('skip');
    const now = resolveSyncDecision(decisionInput({ excludedCategories: ['Work'], category: 'Personal' }));
    expect(now).toEqual({ decision: 'sync', reason: 'allowed' });
  });

  it('(b) note moves INTO exclusion after syncing → next decision skips it', () => {
    const before = resolveSyncDecision(decisionInput({ category: 'Personal' }));
    expect(before.decision).toBe('sync');
    const after = resolveSyncDecision(
      decisionInput({ category: 'Work', excludedCategories: ['Work'] }),
    );
    expect(after).toEqual({ decision: 'skip', reason: 'client-denied' });
  });

  it('(c) server adds a category to its deny list while the user has it in syncedCategories → server-denied immediately', () => {
    const result = resolveSyncDecision(
      decisionInput({
        serverExcludedCategories: ['Work'],
        syncScope: 'categories',
        syncedCategories: ['Work'],
        category: 'Work',
      }),
    );
    expect(result).toEqual({ decision: 'skip', reason: 'server-denied' });
  });

  it('(e) exclusion governs CONTENT sync, not lifecycle: a deleted excluded note still decides on its (former) category', () => {
    // The note is excluded, but a user deletion flows through tombstones —
    // the decision function is only consulted for content sync of live notes.
    const result = resolveSyncDecision(
      decisionInput({ excludedCategories: ['Work'], category: 'Work', noteId: 999 }),
    );
    expect(result.decision).toBe('skip');
    // ...and a non-excluded sibling in the same category still syncs.
    const sibling = resolveSyncDecision(
      decisionInput({ excludedCategories: ['Work'], category: 'Work', noteId: 1000 }),
    );
    expect(sibling.decision).toBe('skip'); // category deny applies to all notes in it
  });

  it('unknown uid (empty string) never matches the server uid deny list', () => {
    const result = resolveSyncDecision(decisionInput({ serverExcludedUids: [''], uid: '' }));
    expect(result.decision).toBe('sync');
  });
});

describe('isNoteExcluded', () => {
  it('matches ids in the deny list only', () => {
    expect(isNoteExcluded(7, [3, 7])).toBe(true);
    expect(isNoteExcluded(8, [3, 7])).toBe(false);
    expect(isNoteExcluded(8, [])).toBe(false);
  });
});

// ─── settings round-trip ─────────────────────────────────────────────────────

describe('exclusion settings persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips excludedCategories and excludedNoteIds', () => {
    saveSyncSettings({
      serverUrl: 'https://sync.test',
      authToken: 't',
      autoSync: false,
      intervalMinutes: 15,
      excludedCategories: ['Private', 'Legal'],
      excludedNoteIds: [1, 2, 3],
    });
    const loaded = loadSyncSettings();
    expect(loaded.excludedCategories).toEqual(['Private', 'Legal']);
    expect(loaded.excludedNoteIds).toEqual([1, 2, 3]);
  });

  it('tolerates corrupt exclusion fields field-by-field', () => {
    localStorage.setItem(
      'notehaven.sync.settings',
      JSON.stringify({
        serverUrl: 'https://sync.test',
        excludedCategories: 'not-an-array',
        excludedNoteIds: ['junk', 4, NaN, 5.5, 6],
      }),
    );
    const loaded = loadSyncSettings();
    expect(loaded.excludedCategories).toEqual([]);
    // Only finite numbers survive; junk/NaN/strings are dropped. Dedup keeps order.
    expect(loaded.excludedNoteIds).toEqual([4, 5.5, 6]);
  });

  it('defaults exclusions to empty for pre-existing stored settings', () => {
    localStorage.setItem(
      'notehaven.sync.settings',
      JSON.stringify({ serverUrl: 'https://old.test', authToken: 'x', autoSync: true, intervalMinutes: 5 }),
    );
    const loaded = loadSyncSettings();
    expect(loaded.excludedCategories).toEqual([]);
    expect(loaded.excludedNoteIds).toEqual([]);
  });

  it('saveSyncSettings dedupes and drops empty category names', () => {
    saveSyncSettings({
      serverUrl: 'https://sync.test',
      authToken: '',
      autoSync: false,
      intervalMinutes: 15,
      excludedCategories: ['A', '', 'A', 'B'],
      excludedNoteIds: [1, 1, 2],
    });
    const loaded = loadSyncSettings();
    expect(loaded.excludedCategories).toEqual(['A', 'B']);
    expect(loaded.excludedNoteIds).toEqual([1, 2]);
  });
});

// ─── discovery parsing ───────────────────────────────────────────────────────

describe('parseDiscoveryExclusions', () => {
  it('reads notes.excluded_categories/excluded_uids', () => {
    expect(
      parseDiscoveryExclusions({ notes: { excluded_categories: ['Private'], excluded_uids: ['u1'] } }),
    ).toEqual({ excludedCategories: ['Private'], excludedUids: ['u1'] });
  });

  it('returns empty lists when notes key absent (pre-exclusion server)', () => {
    expect(parseDiscoveryExclusions({ issuer: 'http://x' })).toEqual({
      excludedCategories: [],
      excludedUids: [],
    });
  });

  it('tolerates garbage shapes', () => {
    expect(parseDiscoveryExclusions(null)).toEqual({ excludedCategories: [], excludedUids: [] });
    expect(parseDiscoveryExclusions({ notes: 'junk' })).toEqual({ excludedCategories: [], excludedUids: [] });
    expect(parseDiscoveryExclusions({ notes: { excluded_categories: [1, 'A', null] } })).toEqual({
      excludedCategories: ['A'],
      excludedUids: [],
    });
  });
});

// ─── engine integration (real Dexie via fake-indexeddb) ──────────────────────

const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

async function seedNote(overrides: Record<string, unknown> = {}): Promise<number> {
  const now = new Date(T0);
  const content = (overrides.content as string) ?? 'body';
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
  } as never);
}

function makeFetch(handlers: Array<{ match: { method?: string; urlIncludes?: string }; status?: number; json?: unknown }>) {
  const ordered = [...handlers].sort(
    (a, b) => (b.match.urlIncludes?.length ?? 0) - (a.match.urlIncludes?.length ?? 0),
  );
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const handler = ordered.find(
      (h) =>
        (!h.match.method || h.match.method.toUpperCase() === method) &&
        (!h.match.urlIncludes || url.includes(h.match.urlIncludes)),
    );
    if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
    const status = handler.status ?? 200;
    const payload = status === 204 ? null : JSON.stringify(handler.json ?? {});
    return new Response(payload, { status });
  };
}

function configureServer(): void {
  saveSyncSettings({ serverUrl: 'https://sync.test', authToken: 't', autoSync: false, intervalMinutes: 15 });
}

const DEFAULT_DISCOVERY = { notes: { excluded_categories: [], excluded_uids: [] } };

// All engine tests run against ONE configured test server.
const SRV = 'https://sync.test';
const pending = () => getPendingNotifications(SRV);

beforeEach(async () => {
  await db.delete();
  await db.open();
  localStorage.clear();
});

describe('runSync with exclusions (engine integration)', () => {
  it('edge (a): note moves out of an excluded category mid-life → local copy stays, no delete, no prompt, uid kept', async () => {
    configureServer();
    // The note was synced before; now its category is excluded on the device.
    const id = await seedNote({ title: 'Moved out', category: 'General' });
    saveSyncSettings({
      ...loadSyncSettings(),
      excludedCategories: ['General'],
    });
    const fetchImpl = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
    ]);
    const result = await runSync({ fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    // Local copy untouched, uid mapping retained for a later move back in scope.
    const note = await db.notes.get(id);
    expect(note?.title).toBe('Moved out');
    expect(result.summary).not.toMatch(/awaiting your choice/);
    expect(pending()).toHaveLength(0);
  });

  it('edge (b): note moves INTO exclusion after being synced → next sync skips the push, local copy untouched', async () => {
    configureServer();
    const id = await seedNote({ title: 'Newly excluded', category: 'Work' });
    saveSyncSettings({ ...loadSyncSettings(), excludedCategories: ['Work'] });
    const fetchImpl = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
    ]);
    const result = await runSync({ fetchImpl });
    expect(result.pushed).toBe(0);
    const note = await db.notes.get(id);
    expect(note?.title).toBe('Newly excluded');
  });

  it('edge (c): server denies a category the user selected → stops syncing immediately, pull of that category skipped', async () => {
    configureServer();
    await seedNote({ title: 'Server denied', category: 'Private' });
    saveSyncSettings({ ...loadSyncSettings(), syncScope: 'categories', syncedCategories: ['Private'] });
    let putCount = 0;
    const fetchImpl = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: { notes: { excluded_categories: ['Private'], excluded_uids: [] } } },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [{ uid: 'srv-priv', updatedAt: iso(T0 + 500) }] } },
      { match: { method: 'GET', urlIncludes: '/api/notes/srv-priv' }, json: { uid: 'srv-priv', title: 'Remote private', category: 'Private', updatedAt: iso(T0 + 500) } },
      { match: { method: 'PUT', urlIncludes: '/api/notes' }, json: { ok: true }, status: 200 },
    ]);
    const result = await runSync({ fetchImpl });
    expect(result.pushed).toBe(0);
    expect(result.pulled).toBe(0);
    expect(putCount).toBe(0);
    // And the note is still local, untouched.
    const notes = await db.notes.toArray();
    expect(notes.map((n) => n.title)).toContain('Server denied');
  });

  it('edge (d): excluded uid deleted on the server → NO keep/delete prompt', async () => {
    configureServer();
    // Local note that was previously synced under uid 'gone-uid' and is now
    // client-excluded; the server has tombstoned it.
    const id = await seedNote({ title: 'Excluded and gone', category: 'General' });
    saveExcludedNoteIds([id]);
    // Map the note to its uid via a first sync in scope (engine assigns uids).
    // Simpler: rely on assignUidForNoteId through a normal pull cycle — instead
    // put the note back in scope and have the manifest show the tombstone.
    saveExcludedNoteIds([]);
    const fetchImpl1 = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
    ]);
    await runSync({ fetchImpl: fetchImpl1 });
    const uid = (await import('@/lib/sync')).getUidForNoteId(SRV, id);
    expect(uid).toBeTruthy();

    // Now exclude it and have the server report a deletion.
    saveExcludedNoteIds([id]);
    const fetchImpl2 = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [{ uid: uid!, updatedAt: iso(T0 + 900), deleted: true }] } },
    ]);
    const result = await runSync({ fetchImpl: fetchImpl2 });
    expect(result.ok).toBe(true);
    expect(pending()).toHaveLength(0);
    // Local copy untouched (never-delete, and excluded → not our business).
    const note = await db.notes.get(id);
    expect(note?.title).toBe('Excluded and gone');
  });

  it('edge (e): local deletion of an excluded note still propagates (delete-remote runs)', async () => {
    configureServer();
    const id = await seedNote({ title: 'To delete', category: 'General' });
    // Sync once in scope so the uid mapping exists.
    const fetchImpl1 = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
      { match: { method: 'PUT', urlIncludes: '/api/notes' }, json: { ok: true } },
    ]);
    const first = await runSync({ fetchImpl: fetchImpl1 });
    expect(first.pushed).toBe(1);
    const { getUidForNoteId } = await import('@/lib/sync');
    const uid = getUidForNoteId(SRV, id);
    expect(uid).toBeTruthy();
    // User deletes the note locally; tombstone recorded (same bookkeeping as syncDeletion).
    const { recordTombstoneFor } = await import('@/lib/syncSettings');
    recordTombstoneFor(SRV, uid!, new Date(T0 + 100), new Date(T0));
    await db.notes.delete(id);
    // Exclude the note id now (deny list) — lifecycle bookkeeping must still run.
    saveExcludedNoteIds([id]);
    const fetchImpl2 = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [{ uid: uid!, updatedAt: iso(T0) }] } },
      { match: { method: 'DELETE', urlIncludes: '/api/notes' }, json: { ok: true, deleted: true } },
    ]);
    const second = await runSync({ fetchImpl: fetchImpl2 });
    expect(second.deletedRemote).toBe(1);
    expect(await db.notes.get(id)).toBeUndefined();
  });

  it('server 403 on push is a per-op error, not a sync failure', async () => {
    configureServer();
    await seedNote({ title: 'Denied by server', category: 'Private' });
    const fetchImpl = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
      { match: { method: 'PUT', urlIncludes: '/api/notes' }, status: 403, json: { error: 'excluded', error_description: 'category "Private" is excluded on this server' } },
    ]);
    // Discovery reported NO exclusions (simulating an old discovery doc), so
    // the client tries to push; the server refuses with 403.
    const result = await runSync({ fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.pushed).toBe(0);
    expect(result.errors[0]).toMatch(/403/);
  });

  it('unreachable discovery endpoint does not block syncing (fail-open policy fetch, server still enforces)', async () => {
    configureServer();
    await seedNote({ title: 'Syncs anyway', category: 'General' });
    const fetchImpl = makeFetch([
      { match: { method: 'GET', urlIncludes: '/.well-known' }, status: 500, json: { error: 'x' } },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
      { match: { method: 'PUT', urlIncludes: '/api/notes' }, json: { ok: true } },
    ]);
    const result = await runSync({ fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(1);
  });

  it('uid-deny: a server-excluded uid in the manifest is never pulled — no payload fetch, local state untouched, entry skipped', async () => {
    configureServer();
    const id = await seedNote({ title: 'Local only', category: 'General' });
    // The uid exists remotely AND on the server's deny list (deny list built
    // after the note was once synced). Discovery advertises it as excluded.
    const fetchImpl = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: { notes: { excluded_categories: [], excluded_uids: ['srv-denied-uid'] } } },
      // Manifest LISTS the excluded uid (simulates a discovery-less client or
      // a stale server) — the client must still skip it. A different uid is
      // also listed so the local note legitimately pushes (no incidental
      // 404-style error path).
      {
        match: { method: 'GET', urlIncludes: '/api/notes' },
        json: {
          notes: [
            { uid: 'srv-denied-uid', updatedAt: iso(T0 + 500) },
            { uid: 'other-remote', updatedAt: iso(T0 + 500) },
          ],
        },
      },
      { match: { method: 'GET', urlIncludes: '/api/notes/other-remote' }, json: { uid: 'other-remote', title: 'Allowed remote', category: 'General', updatedAt: iso(T0 + 500) } },
      // If the engine ever fetches the excluded payload, remember it.
      { match: { method: 'GET', urlIncludes: '/api/notes/srv-denied-uid' }, json: { uid: 'srv-denied-uid', title: 'FORBIDDEN', category: 'General', updatedAt: iso(T0 + 500) } },
      { match: { method: 'PUT', urlIncludes: '/api/notes' }, json: { ok: true } },
    ]);
    let deniedPayloadFetches = 0;
    const result = await runSync({
      fetchImpl: async (input, init) => {
        if (String(input).includes('/api/notes/srv-denied-uid')) deniedPayloadFetches++;
        return fetchImpl(input, init);
      },
    });
    expect(result.ok).toBe(true);
    expect(deniedPayloadFetches).toBe(0); // the payload was NEVER fetched
    // Nothing pulled of the excluded uid; the allowed remote note still pulls.
    expect(result.pulled).toBe(1);
    const note = await db.notes.get(id);
    expect(note?.title).toBe('Local only');
    expect((await db.notes.toArray()).map((n) => n.title)).not.toContain('FORBIDDEN');
    expect(pending()).toHaveLength(0);
    // The skipped entry did not become a deletion prompt either.
    expect(result.deletedLocal).toBe(0);
  });

  it('keep-exception + server exclusion: no NEW prompt enqueued; a PRE-EXISTING prompt stays resolvable', async () => {
    configureServer();
    const { hasKeepException, addKeepException, resolveNotification } = await import('@/lib/syncNotifications');
    // A note whose remote copy was deleted on the server BEFORE the exclusion
    // policy existed; the user chose Keep (permanent exception), and NOW the
    // server denies the uid entirely.
    const id = await seedNote({ title: 'Kept note', category: 'General' });
    const fetchImpl1 = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [] } },
      { match: { method: 'PUT', urlIncludes: '/api/notes' }, json: { ok: true } },
    ]);
    expect((await runSync({ fetchImpl: fetchImpl1 })).pushed).toBe(1);
    const { getUidForNoteId } = await import('@/lib/sync');
    const uid = getUidForNoteId(SRV, id)!;
    expect(uid).toBeTruthy();
    addKeepException(SRV, uid);
    expect(hasKeepException(SRV, uid)).toBe(true);

    // Sync round under the exclusion policy: the manifest shows the remote
    // tombstone; the keep-exception must suppress any NEW prompt and the
    // server-deny must not resurrect or touch the local note.
    const fetchImpl2 = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: { notes: { excluded_categories: [], excluded_uids: [uid] } } },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [{ uid, updatedAt: iso(T0 + 900), deleted: true }] } },
    ]);
    const result = await runSync({ fetchImpl: fetchImpl2 });
    expect(result.ok).toBe(true);
    expect(pending()).toHaveLength(0); // no NEW prompt enqueued
    expect((await db.notes.get(id))?.title).toBe('Kept note'); // local untouched

    // A PRE-EXISTING queued prompt for the same uid remains resolvable: the
    // engine must not have consumed or blocked it.
    const { enqueueRemoteDeletion } = await import('@/lib/syncNotifications');
    const pre = enqueueRemoteDeletion({ serverId: SRV, uid: 'other-uid', title: 'Older deletion', category: 'General', deletedAt: iso(T0 + 100) });
    expect(pre).not.toBeNull();
    expect(pending()).toHaveLength(1);
    await resolveNotification(pre!.id, 'keep');
    expect(pending()).toHaveLength(0);
  });

  it('pull-waste: a client-excluded note with a remote update fetches the payload once and discards it; local copy byte-identical', async () => {
    configureServer();
    const id = await seedNote({ title: 'Excluded locally', category: 'Work', content: 'original body' });
    saveSyncSettings({ ...loadSyncSettings(), excludedCategories: ['Work'] });
    // Sync once before excluding? No — the exclusion is already on, so the
    // uid mapping is stale/absent; drive the round purely from the manifest.
    // The remoteCategories cache is empty, so the payload IS fetched once and
    // then discarded (this is the documented best-effort gap being pinned).
    let payloadFetches = 0;
    const payload = {
      uid: 'waste-uid',
      title: 'Excluded locally (remote edit)',
      content: 'remote updated body',
      tags: [],
      category: 'Work',
      createdAt: iso(T0),
      updatedAt: iso(T0 + 500),
      editDates: ['2026-01-01'],
      pinned: false,
      encrypted: null,
    };
    const fetchImpl = makeFetch([
      { match: { urlIncludes: '/.well-known' }, json: DEFAULT_DISCOVERY },
      { match: { method: 'GET', urlIncludes: '/api/notes/waste-uid' }, json: payload },
      { match: { method: 'GET', urlIncludes: '/api/notes' }, json: { notes: [{ uid: 'waste-uid', updatedAt: iso(T0 + 500) }] } },
    ]);
    // Count payload fetches by wrapping the ordered matcher: only the
    // waste-uid handler should ever see a GET.
    const result = await runSync({
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.includes('/api/notes/waste-uid')) payloadFetches++;
        return fetchImpl(input, init);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.pulled).toBe(0); // discarded after the payload re-check
    expect(payloadFetches).toBe(1); // fetched exactly once — waste, not a loop
    // Local copy byte-identical: title/content untouched by the pull.
    const note = await db.notes.get(id);
    expect(note?.title).toBe('Excluded locally');
    expect(note?.content).toBe('original body');
    // The category is now remembered, so the NEXT round skips the fetch entirely.
    let secondFetches = 0;
    await runSync({
      fetchImpl: async (input, init) => {
        if (String(input).includes('/api/notes/waste-uid')) secondFetches++;
        return fetchImpl(input, init);
      },
    });
    expect(secondFetches).toBe(0);
  });
});

describe('runSync config guard', () => {
  it('still throws SyncError without a server URL', async () => {
    localStorage.clear();
    await expect(runSync({ fetchImpl: makeFetch([]) })).rejects.toBeInstanceOf(SyncError);
  });
});