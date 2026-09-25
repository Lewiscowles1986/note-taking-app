/**
 * Unit tests for the multi-server store (src/lib/syncServers.ts): the server
 * list (add/list/remove/rename, idempotent add), per-server settings, the
 * device-wide note-exclusion key, and the one-time migration of the legacy
 * single-server blobs (idempotent, lossless, legacy keys untouched).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addServer,
  listServers,
  listServerIds,
  removeServer,
  renameServer,
  getServerSettings,
  saveServerSettings,
  clearServerData,
  loadExcludedNoteIds,
  saveExcludedNoteIds,
  tombstonesKey,
  uidMapKey,
  remoteCategoriesKey,
  notificationsKey,
  keepExceptionsKey,
  oidcKey,
  EXCLUDED_NOTES_KEY,
} from '@/lib/syncServers';
import { saveSyncSettings, loadSyncSettings } from '@/lib/syncSettings';

beforeEach(() => {
  localStorage.clear();
});

// ─── server list ─────────────────────────────────────────────────────────────

describe('server list', () => {
  it('starts empty', () => {
    expect(listServers()).toEqual([]);
    expect(listServerIds()).toEqual([]);
  });

  it('adds a server with a normalized-URL id', () => {
    const record = addServer('https://sync.example.com///');
    expect(record.id).toBe('https://sync.example.com');
    expect(listServerIds()).toEqual(['https://sync.example.com']);
    expect(record.addedAt).toBeTruthy();
  });

  it('add is idempotent — an existing URL returns the existing record', () => {
    const first = addServer('https://a.dev', 'Alpha');
    const second = addServer('https://a.dev/', 'Beta');
    expect(second.id).toBe(first.id);
    expect(second.label).toBe('Alpha'); // label preserved, not overwritten
    expect(listServers()).toHaveLength(1);
  });

  it('keeps insertion order and supports multiple servers', () => {
    addServer('https://one.dev');
    addServer('https://two.dev');
    addServer('https://three.dev');
    expect(listServerIds()).toEqual(['https://one.dev', 'https://two.dev', 'https://three.dev']);
  });

  it('renames a server and clears the label with an empty string', () => {
    addServer('https://a.dev', 'Alpha');
    renameServer('https://a.dev', 'Work');
    expect(listServers()[0].label).toBe('Work');
    renameServer('https://a.dev', '  ');
    expect(listServers()[0].label).toBeUndefined();
  });

  it('removeServer wipes the record AND every per-server key', () => {
    addServer('https://a.dev');
    saveServerSettings('https://a.dev', {
      authToken: 't',
      autoSync: true,
      intervalMinutes: 5,
      syncScope: 'all',
      syncedCategories: [],
      excludedCategories: [],
      excludedNoteIds: [],
      lastSync: null,
    });
    localStorage.setItem(tombstonesKey('https://a.dev'), '[]');
    localStorage.setItem(uidMapKey('https://a.dev'), '{"1":"u1"}');
    localStorage.setItem(remoteCategoriesKey('https://a.dev'), '{}');
    localStorage.setItem(notificationsKey('https://a.dev'), '[]');
    localStorage.setItem(keepExceptionsKey('https://a.dev'), '{}');
    localStorage.setItem(oidcKey('https://a.dev'), '{}');

    removeServer('https://a.dev');

    expect(listServers()).toEqual([]);
    expect(localStorage.getItem(`notehaven.sync.server.https://a.dev`)).toBeNull();
    for (const key of [
      tombstonesKey('https://a.dev'),
      uidMapKey('https://a.dev'),
      remoteCategoriesKey('https://a.dev'),
      notificationsKey('https://a.dev'),
      keepExceptionsKey('https://a.dev'),
      oidcKey('https://a.dev'),
    ]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('allows removing ALL servers (empty state is valid)', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    removeServer('https://a.dev');
    removeServer('https://b.dev');
    expect(listServers()).toEqual([]);
    expect(localStorage.getItem('notehaven.sync.servers')).toBeNull();
  });

  it('rejects an empty URL', () => {
    expect(() => addServer('   ')).toThrow();
  });
});

// ─── per-server settings ─────────────────────────────────────────────────────

describe('per-server settings', () => {
  it('defaults are independent per server', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    expect(getServerSettings('https://a.dev')).toMatchObject({
      serverUrl: 'https://a.dev',
      authToken: '',
      autoSync: false,
      intervalMinutes: 15,
      syncScope: 'all',
      lastSync: null,
    });
  });

  it('round-trips settings for the right server only', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    saveServerSettings('https://a.dev', {
      authToken: 'tok-a',
      autoSync: true,
      intervalMinutes: 9,
      syncScope: 'categories',
      syncedCategories: ['Work'],
      excludedCategories: ['Private'],
      excludedNoteIds: [],
      lastSync: { at: '2026-01-01T00:00:00.000Z', ok: true, summary: '1 pushed' },
    });

    expect(getServerSettings('https://a.dev')).toMatchObject({
      serverUrl: 'https://a.dev',
      authToken: 'tok-a',
      autoSync: true,
      intervalMinutes: 9,
      syncScope: 'categories',
      syncedCategories: ['Work'],
      lastSync: { summary: '1 pushed' },
    });
    // b untouched.
    expect(getServerSettings('https://b.dev')).toMatchObject({ authToken: '', lastSync: null });
  });

  it('tolerates corrupt per-server blobs field-by-field', () => {
    addServer('https://a.dev');
    localStorage.setItem('notehaven.sync.server.https://a.dev', '{not json');
    expect(getServerSettings('https://a.dev').authToken).toBe('');

    localStorage.setItem(
      'notehaven.sync.server.https://a.dev',
      JSON.stringify({ authToken: 'kept', intervalMinutes: 'nope', lastSync: 'junk' }),
    );
    const settings = getServerSettings('https://a.dev');
    expect(settings.authToken).toBe('kept');
    expect(settings.intervalMinutes).toBe(15);
    expect(settings.lastSync).toBeNull();
  });

  it('clearServerData wipes settings but keeps OTHER servers', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    saveServerSettings('https://a.dev', {
      authToken: 'x',
      autoSync: false,
      intervalMinutes: 15,
      syncScope: 'all',
      syncedCategories: [],
      excludedCategories: [],
      excludedNoteIds: [],
      lastSync: null,
    });
    localStorage.setItem(tombstonesKey('https://a.dev'), '[]');

    clearServerData('https://a.dev');

    expect(getServerSettings('https://a.dev').authToken).toBe('');
    expect(localStorage.getItem(tombstonesKey('https://a.dev'))).toBeNull();
    expect(listServerIds()).toEqual(['https://a.dev', 'https://b.dev']);
    expect(getServerSettings('https://b.dev').serverUrl).toBe('https://b.dev');
  });
});

// ─── device-wide note exclusions ─────────────────────────────────────────────

describe('device-wide excluded note ids', () => {
  it('round-trips and dedupes', () => {
    saveExcludedNoteIds([1, 2, 2, 3]);
    expect(loadExcludedNoteIds()).toEqual([1, 2, 3]);
  });

  it('tolerates corrupt storage', () => {
    localStorage.setItem(EXCLUDED_NOTES_KEY, '{nope');
    expect(loadExcludedNoteIds()).toEqual([]);
    localStorage.setItem(EXCLUDED_NOTES_KEY, '["junk",4]');
    expect(loadExcludedNoteIds()).toEqual([4]);
  });

  it('is SHARED across servers (not part of any per-server blob)', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    saveExcludedNoteIds([7]);
    expect(getServerSettings('https://a.dev').excludedNoteIds).toEqual([7]);
    expect(getServerSettings('https://b.dev').excludedNoteIds).toEqual([7]);
  });
});

// ─── migration ───────────────────────────────────────────────────────────────

describe('legacy single-server migration', () => {
  it('migrates the legacy settings blob into the first server slot', () => {
    saveSyncSettings({ serverUrl: 'https://legacy.dev', authToken: 'old-tok', autoSync: true, intervalMinutes: 7 });
    localStorage.setItem('notehaven.sync.tombstones', JSON.stringify([{ uid: 'u1', deletedAt: '2026-01-01', noteUpdatedAt: '2026-01-01' }]));
    localStorage.setItem('notehaven.sync.uidMap', JSON.stringify({ '3': 'uid-3' }));
    localStorage.setItem('notehaven.sync.oidc', JSON.stringify({ config: { issuer: 'https://legacy.dev' }, session: { accessToken: 'at' } }));

    expect(listServers()).toEqual([
      { id: 'https://legacy.dev', label: undefined, addedAt: expect.any(String) },
    ]);
    expect(getServerSettings('https://legacy.dev')).toMatchObject({
      serverUrl: 'https://legacy.dev',
      authToken: 'old-tok',
      autoSync: true,
      intervalMinutes: 7,
    });
    expect(JSON.parse(localStorage.getItem(tombstonesKey('https://legacy.dev'))!)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(uidMapKey('https://legacy.dev'))!)).toEqual({ '3': 'uid-3' });
    expect(JSON.parse(localStorage.getItem(oidcKey('https://legacy.dev'))!).config.issuer).toBe('https://legacy.dev');

    // Legacy keys are NOT deleted (no data loss if migration has a bug) —
    // they are simply never read again.
    expect(localStorage.getItem('notehaven.sync.settings')).not.toBeNull();
    expect(localStorage.getItem('notehaven.sync.tombstones')).not.toBeNull();
    expect(loadSyncSettings().serverUrl).toBe('https://legacy.dev');
  });

  it('migration is idempotent (done-marker key)', () => {
    saveSyncSettings({ serverUrl: 'https://legacy.dev', authToken: 't', autoSync: false, intervalMinutes: 15 });
    listServers(); // triggers migration
    // A second "legacy" write must NOT create a second server or clobber.
    saveSyncSettings({ serverUrl: 'https://other.dev', authToken: 't2', autoSync: false, intervalMinutes: 15 });
    listServers();
    expect(listServerIds()).toEqual(['https://legacy.dev']);
  });

  it('does not migrate when the legacy settings have no server URL', () => {
    saveSyncSettings({ serverUrl: '', authToken: '', autoSync: false, intervalMinutes: 15 });
    expect(listServers()).toEqual([]);
    expect(localStorage.getItem('notehaven.sync.servers')).toBeNull();
  });

  it('never runs when a server list already exists (post-migration user wins)', () => {
    // A user who already added servers in the new format must not have the
    // legacy blob resurrect an old server.
    addServer('https://new.dev');
    saveSyncSettings({ serverUrl: 'https://legacy.dev', authToken: 't', autoSync: false, intervalMinutes: 15 });
    listServers();
    expect(listServerIds()).toEqual(['https://new.dev']);
  });

  it('carries the legacy note-exclusion list into the device-wide key', () => {
    saveSyncSettings({ serverUrl: 'https://legacy.dev', authToken: '', autoSync: false, intervalMinutes: 15, excludedNoteIds: [4, 5] });
    listServers();
    expect(loadExcludedNoteIds()).toEqual([4, 5]);
  });
});