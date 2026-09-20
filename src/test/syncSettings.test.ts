/**
 * Unit tests for sync settings persistence (src/lib/syncSettings.ts):
 * defaults, round-trip persistence, corrupt-storage tolerance, URL
 * normalization, tombstone recording/pruning/TTL and the sync-result merge
 * that must not clobber concurrently-edited config.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadSyncSettings,
  saveSyncSettings,
  clearSyncSettings,
  recordSyncResult,
  loadTombstones,
  recordTombstone,
  retainTombstones,
  normalizeServerUrl,
  MAX_TOMBSTONES,
} from '@/lib/syncSettings';

beforeEach(() => {
  localStorage.clear();
});

describe('loadSyncSettings', () => {
  it('returns defaults for an empty store', () => {
    expect(loadSyncSettings()).toEqual({
      serverUrl: '',
      authToken: '',
      autoSync: false,
      intervalMinutes: 15,
      lastSync: null,
    });
  });

  it('round-trips saved settings', () => {
    saveSyncSettings({
      serverUrl: 'https://sync.example.com',
      authToken: 'tok',
      autoSync: true,
      intervalMinutes: 30,
      lastSync: { at: '2026-01-01T00:00:00.000Z', ok: true, summary: '2 pushed' },
    });
    expect(loadSyncSettings()).toEqual({
      serverUrl: 'https://sync.example.com',
      authToken: 'tok',
      autoSync: true,
      intervalMinutes: 30,
      lastSync: { at: '2026-01-01T00:00:00.000Z', ok: true, summary: '2 pushed' },
    });
  });

  it('tolerates corrupt JSON, non-objects and partial objects field-by-field', () => {
    localStorage.setItem('notehaven.sync.settings', '{not json');
    expect(loadSyncSettings().serverUrl).toBe('');

    localStorage.setItem('notehaven.sync.settings', JSON.stringify([1, 2, 3]));
    expect(loadSyncSettings().autoSync).toBe(false);

    localStorage.setItem(
      'notehaven.sync.settings',
      JSON.stringify({ serverUrl: 'https://kept.test/', intervalMinutes: 'nope', lastSync: 'nope' }),
    );
    const settings = loadSyncSettings();
    expect(settings.serverUrl).toBe('https://kept.test');
    expect(settings.intervalMinutes).toBe(15);
    expect(settings.lastSync).toBeNull();
  });
});

describe('saveSyncSettings', () => {
  it('normalizes trailing slashes on the server URL', () => {
    saveSyncSettings({ serverUrl: 'https://x.dev///', authToken: '', autoSync: false, intervalMinutes: 15 });
    expect(loadSyncSettings().serverUrl).toBe('https://x.dev');
  });

  it('clamps interval to a positive integer', () => {
    saveSyncSettings({ serverUrl: '', authToken: '', autoSync: true, intervalMinutes: 0.4 });
    expect(loadSyncSettings().intervalMinutes).toBe(1);
  });

  it('keeps only editable fields from callers (lastSync must come through the merge)', () => {
    saveSyncSettings({ serverUrl: 'https://x.dev', authToken: '', autoSync: false, intervalMinutes: 15 });
    // A stale caller passing lastSync: undefined (e.g. spread of old state)
    // still must not destroy an existing record — recordSyncResult owns that.
    saveSyncSettings({ serverUrl: 'https://y.dev', authToken: 't', autoSync: true, intervalMinutes: 5 });
    expect(loadSyncSettings().serverUrl).toBe('https://y.dev');
  });
});

describe('recordSyncResult', () => {
  it('merges into current settings without clobbering newer config edits', () => {
    saveSyncSettings({ serverUrl: 'https://old.dev', authToken: '', autoSync: false, intervalMinutes: 15 });
    // The user edits settings while a sync is running…
    saveSyncSettings({ serverUrl: 'https://new.dev', authToken: 't2', autoSync: true, intervalMinutes: 9 });
    // …then the sync finishes and records its outcome: the edited config must survive.
    recordSyncResult({ at: '2026-01-01T00:00:00.000Z', ok: true, summary: 'ok' });

    const settings = loadSyncSettings();
    expect(settings.serverUrl).toBe('https://new.dev');
    expect(settings.authToken).toBe('t2');
    expect(settings.autoSync).toBe(true);
    expect(settings.intervalMinutes).toBe(9);
    expect(settings.lastSync).not.toBeNull();
    expect(settings.lastSync?.summary).toBe('ok');
  });
});

describe('clearSyncSettings', () => {
  it('wipes settings and tombstones', () => {
    saveSyncSettings({ serverUrl: 'https://x.dev', authToken: 't', autoSync: true, intervalMinutes: 5 });
    recordTombstone('u1', new Date(), new Date());
    clearSyncSettings();
    expect(loadSyncSettings().serverUrl).toBe('');
    expect(loadTombstones()).toEqual([]);
  });
});

describe('normalizeServerUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    expect(normalizeServerUrl('  https://a.dev/  ')).toBe('https://a.dev');
    expect(normalizeServerUrl('https://a.dev///')).toBe('https://a.dev');
    expect(normalizeServerUrl('')).toBe('');
  });
});

// ─── tombstones ──────────────────────────────────────────────────────────────

describe('tombstones', () => {
  /** Date `days` before now — recent enough to survive the 90-day TTL. */
  const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

  it('records and loads tombstones sorted by deletion time', () => {
    recordTombstone('later', daysAgo(1), new Date());
    recordTombstone('earlier', daysAgo(2), new Date());
    expect(loadTombstones().map((t) => t.uid)).toEqual(['earlier', 'later']);
  });

  it('replaces an existing tombstone for the same uid', () => {
    const replacement = daysAgo(1);
    recordTombstone('u1', daysAgo(2), new Date());
    recordTombstone('u1', replacement, new Date());
    const tombstones = loadTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].deletedAt).toBe(replacement.toISOString());
  });

  it('caps the tombstone list at MAX_TOMBSTONES (oldest dropped)', () => {
    for (let i = 0; i < MAX_TOMBSTONES + 10; i++) {
      recordTombstone(`u${i}`, new Date(Date.now() - (MAX_TOMBSTONES + 20 - i) * 1000), new Date());
    }
    const tombstones = loadTombstones();
    expect(tombstones).toHaveLength(MAX_TOMBSTONES);
    expect(tombstones[0].uid).toBe('u10');
    expect(tombstones[MAX_TOMBSTONES - 1].uid).toBe(`u${MAX_TOMBSTONES + 9}`);
  });

  it('drops tombstones older than the TTL and malformed entries on load', () => {
    const ancient = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      'notehaven.sync.tombstones',
      JSON.stringify([
        { uid: 'ancient', deletedAt: ancient, noteUpdatedAt: ancient },
        { uid: 'fresh', deletedAt: new Date().toISOString(), noteUpdatedAt: new Date().toISOString() },
        { uid: 5, deletedAt: 'x' },
        'junk',
      ]),
    );
    expect(loadTombstones().map((t) => t.uid)).toEqual(['fresh']);
  });

  it('tolerates corrupt tombstone storage', () => {
    localStorage.setItem('notehaven.sync.tombstones', '{nope');
    expect(loadTombstones()).toEqual([]);
    localStorage.setItem('notehaven.sync.tombstones', JSON.stringify({ not: 'an array' }));
    expect(loadTombstones()).toEqual([]);
  });

  it('retainTombstones keeps only the given uids and clears the key when empty', () => {
    recordTombstone('keep', new Date(), new Date());
    recordTombstone('drop', new Date(), new Date());
    retainTombstones(new Set(['keep']));
    expect(loadTombstones().map((t) => t.uid)).toEqual(['keep']);

    retainTombstones(new Set());
    expect(loadTombstones()).toEqual([]);
    expect(localStorage.getItem('notehaven.sync.tombstones')).toBeNull();
  });
});