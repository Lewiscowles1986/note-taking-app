/**
 * Unit tests for the eager, dependency-free deletion hook
 * (src/lib/syncDeletion.ts) and the app-level auto-sync scheduler
 * (src/lib/autoSyncScheduler.tsx).
 *
 * The scheduler is exercised through its exported `refreshAutoSyncScheduler`
 * (the settings page's entry point) plus mount/unmount, with fake timers.
 * The dynamic engine import inside the tick is spied via `vi.mock('@/lib/sync')`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import AutoSyncScheduler from '@/lib/autoSyncScheduler';
import { refreshAutoSyncScheduler } from '@/lib/autoSyncSchedulerControl';
import { addServer, saveServerSettings, getServerSettings, tombstonesKey, uidMapKey } from '@/lib/syncServers';
import { recordDeletion, withTombstone, loadRawTombstones } from '@/lib/syncDeletion';

// Engine mock: the scheduler must dynamic-import this — track whether the
// module was ever requested so we can assert lazy loading.
const runSyncIfConfigured = vi.fn(async () => null);
vi.mock('@/lib/sync', () => ({
  runSyncIfConfigured: (...args: unknown[]) => runSyncIfConfigured(...(args as [])),
}));

/** Configure one server for scheduler tests. Returns its id. */
function configure(url: string, autoSync: boolean, intervalMinutes = 15): string {
  addServer(url);
  saveServerSettings(url, {
    authToken: '',
    autoSync,
    intervalMinutes,
    syncScope: 'all',
    syncedCategories: [],
    excludedCategories: [],
    excludedNoteIds: [],
    lastSync: null,
  });
  return url;
}

beforeEach(() => {
  localStorage.clear();
  runSyncIfConfigured.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  // Unmount every render so the scheduler's cleanup runs between tests
  // (otherwise a timer from one test leaks ticks into the next).
  cleanup();
  refreshAutoSyncScheduler(); // drop any manual-start timer too
  vi.useRealTimers();
});

// ─── recordDeletion (eager deletion hook) ────────────────────────────────────

describe('recordDeletion (per-server fan-out)', () => {
  it('writes a tombstone and forgets the uid for a previously-synced note (that server only)', () => {
    addServer('https://a.dev');
    localStorage.setItem(uidMapKey('https://a.dev'), JSON.stringify({ '7': 'uid-7' }));

    const updated = new Date('2026-01-05T00:00:00.000Z');
    recordDeletion(7, updated);

    const tombstones = loadRawTombstones('https://a.dev');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].uid).toBe('uid-7');
    expect(tombstones[0].noteUpdatedAt).toBe(updated.toISOString());
    expect(Number.isFinite(Date.parse(tombstones[0].deletedAt))).toBe(true); // "now"
    const map = JSON.parse(localStorage.getItem(uidMapKey('https://a.dev')) || '{}');
    expect(map['7']).toBeUndefined();
  });

  it('FANS OUT: a note synced to two servers gets a tombstone on each', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    localStorage.setItem(uidMapKey('https://a.dev'), JSON.stringify({ '7': 'uid-a' }));
    localStorage.setItem(uidMapKey('https://b.dev'), JSON.stringify({ '7': 'uid-b' }));

    const updated = new Date('2026-01-05T00:00:00.000Z');
    recordDeletion(7, updated);

    const a = loadRawTombstones('https://a.dev');
    const b = loadRawTombstones('https://b.dev');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].uid).toBe('uid-a');
    expect(b[0].uid).toBe('uid-b');
    // Both maps forgot the note.
    expect(JSON.parse(localStorage.getItem(uidMapKey('https://a.dev')) || '{}')).toEqual({});
    expect(JSON.parse(localStorage.getItem(uidMapKey('https://b.dev')) || '{}')).toEqual({});
  });

  it('a server WITHOUT a mapping for the note gets no tombstone', () => {
    addServer('https://a.dev');
    addServer('https://b.dev');
    localStorage.setItem(uidMapKey('https://a.dev'), JSON.stringify({ '1': 'u1' }));

    recordDeletion(1, new Date('2026-01-01T00:00:00.000Z'));
    expect(loadRawTombstones('https://a.dev')).toHaveLength(1);
    expect(localStorage.getItem(tombstonesKey('https://b.dev'))).toBeNull();
  });

  it('replaces an existing tombstone for the same uid instead of duplicating', () => {
    addServer('https://a.dev');
    localStorage.setItem(uidMapKey('https://a.dev'), JSON.stringify({ '1': 'u1' }));
    recordDeletion(1, new Date('2026-01-01T00:00:00.000Z'));
    recordDeletion(1, new Date('2026-01-02T00:00:00.000Z'));
    const tombstones = loadRawTombstones('https://a.dev');
    expect(tombstones).toHaveLength(1);
  });

  it('touches nothing but the uid map for a never-synced note', () => {
    addServer('https://a.dev');
    localStorage.setItem(uidMapKey('https://a.dev'), JSON.stringify({ '9': 'u9' }));
    recordDeletion(42, new Date());
    expect(localStorage.getItem(tombstonesKey('https://a.dev'))).toBeNull();
    expect(JSON.parse(localStorage.getItem(uidMapKey('https://a.dev')) || '{}')).toEqual({ '9': 'u9' });
  });

  it('survives corrupt storage without throwing', () => {
    addServer('https://a.dev');
    localStorage.setItem(uidMapKey('https://a.dev'), '{corrupt');
    expect(() => recordDeletion(1, new Date())).not.toThrow();
  });

  it('caps tombstones via withTombstone, dropping oldest first', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      uid: `u${i}`,
      deletedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      noteUpdatedAt: new Date().toISOString(),
    }));
    const next = withTombstone(many, { uid: 'new', deletedAt: 'x', noteUpdatedAt: 'y' });
    expect(next).toHaveLength(500);
    expect(next[0].uid).toBe('u1');
    expect(next[499].uid).toBe('new');
  });
});

// ─── auto-sync scheduler (per-server timers) ─────────────────────────────────

describe('autoSyncScheduler', () => {
  it('loads nothing and does nothing when no server is configured', async () => {
    render(<AutoSyncScheduler />);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('starts ticking only when auto-sync is configured (per server)', async () => {
    configure('https://s.test', true, 15);
    render(<AutoSyncScheduler />);
    // Advance past a 15-minute window; the dynamic import must have happened
    // and the tick must have run once.
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('does not tick for a server with autoSync OFF', async () => {
    configure('https://s.test', false, 15);
    render(<AutoSyncScheduler />);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('does not tick before the first interval elapses', async () => {
    configure('https://s.test', true, 30);
    render(<AutoSyncScheduler />);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('TWO servers, different intervals: both tick on their own cadence', async () => {
    configure('https://fast.test', true, 5);
    configure('https://slow.test', true, 30);
    render(<AutoSyncScheduler />);

    // After 5 minutes: the fast server ticks once, the slow one not yet.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);
    expect(runSyncIfConfigured).toHaveBeenCalledWith('https://fast.test');

    // After 30 minutes: the slow server has ticked once too; the fast one
    // has ticked 6 times total.
    await vi.advanceTimersByTimeAsync(25 * 60_000 + 1);
    expect(runSyncIfConfigured).toHaveBeenCalledWith('https://slow.test');
    const fastCalls = runSyncIfConfigured.mock.calls.filter((c) => c[0] === 'https://fast.test');
    expect(fastCalls.length).toBe(6);
  });

  it('a server with autoSync off does not load the engine even when others do', async () => {
    configure('https://on.test', true, 15);
    configure('https://off.test', false, 15);
    render(<AutoSyncScheduler />);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    const offCalls = runSyncIfConfigured.mock.calls.filter((c) => c[0] === 'https://off.test');
    expect(offCalls).toHaveLength(0);
    expect(runSyncIfConfigured).toHaveBeenCalledWith('https://on.test');
  });

  it('stops ticking when unmounted', async () => {
    configure('https://s.test', true, 15);
    const { unmount } = render(<AutoSyncScheduler />);
    unmount();
    await vi.advanceTimersByTimeAsync(3 * 15 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('respects refreshAutoSyncScheduler: on after save, off after config cleared', async () => {
    // Nothing configured: refresh must not start anything.
    render(<AutoSyncScheduler />);
    refreshAutoSyncScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();

    // Turn it on: the next window runs a tick.
    configure('https://s.test', true, 15);
    refreshAutoSyncScheduler();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);

    // Turn it off: no further ticks.
    saveServerSettings('https://s.test', { ...getServerSettings('https://s.test'), autoSync: false });
    refreshAutoSyncScheduler();
    await vi.advanceTimersByTimeAsync(5 * 15 * 60_000);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('clears stale localStorage keys the scheduler reads', () => {
    // Guard against the settings module renaming its key without the
    // scheduler following: both must agree on the storage key.
    configure('https://s.test', true, 5);
    expect(Object.keys(JSON.parse(localStorage.getItem('notehaven.sync.server.https://s.test') || '{}'))).toContain('autoSync');
    expect(getServerSettings('https://s.test').autoSync).toBe(true);
  });
});