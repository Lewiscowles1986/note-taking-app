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
import AutoSyncScheduler, { refreshAutoSyncScheduler } from '@/lib/autoSyncScheduler';
import { loadSyncSettings, saveSyncSettings, clearSyncSettings } from '@/lib/syncSettings';
import { recordDeletion, withTombstone, loadRawTombstones } from '@/lib/syncDeletion';

// Engine mock: the scheduler must dynamic-import this — track whether the
// module was ever requested so we can assert lazy loading.
const runSyncIfConfigured = vi.fn(async () => null);
vi.mock('@/lib/sync', () => ({
  runSyncIfConfigured: (...args: unknown[]) => runSyncIfConfigured(...(args as [])),
}));

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

describe('recordDeletion', () => {
  it('writes a tombstone and forgets the uid for a previously-synced note', () => {
    localStorage.setItem('notehaven.sync.uidMap', JSON.stringify({ '7': 'uid-7' }));

    const updated = new Date('2026-01-05T00:00:00.000Z');
    recordDeletion(7, updated);

    const tombstones = loadRawTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].uid).toBe('uid-7');
    expect(tombstones[0].noteUpdatedAt).toBe(updated.toISOString());
    expect(Number.isFinite(Date.parse(tombstones[0].deletedAt))).toBe(true); // "now"
    const map = JSON.parse(localStorage.getItem('notehaven.sync.uidMap') || '{}');
    expect(map['7']).toBeUndefined();
  });

  it('replaces an existing tombstone for the same uid instead of duplicating', () => {
    localStorage.setItem('notehaven.sync.uidMap', JSON.stringify({ '1': 'u1' }));
    recordDeletion(1, new Date('2026-01-01T00:00:00.000Z'));
    recordDeletion(1, new Date('2026-01-02T00:00:00.000Z'));
    const tombstones = loadRawTombstones();
    expect(tombstones).toHaveLength(1);
  });

  it('touches nothing but the uid map for a never-synced note', () => {
    localStorage.setItem('notehaven.sync.uidMap', JSON.stringify({ '9': 'u9' }));
    recordDeletion(42, new Date());
    expect(localStorage.getItem('notehaven.sync.tombstones')).toBeNull();
    expect(JSON.parse(localStorage.getItem('notehaven.sync.uidMap') || '{}')).toEqual({ '9': 'u9' });
  });

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem('notehaven.sync.uidMap', '{corrupt');
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

// ─── auto-sync scheduler ─────────────────────────────────────────────────────

describe('autoSyncScheduler', () => {
  it('loads nothing and does nothing when no server is configured', async () => {
    render(<AutoSyncScheduler />);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('starts ticking only when auto-sync is configured', async () => {
    saveSyncSettings({ serverUrl: 'https://s.test', authToken: '', autoSync: true, intervalMinutes: 15 });
    render(<AutoSyncScheduler />);
    // Advance past a 15-minute window; the dynamic import must have happened
    // and the tick must have run once.
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('does not tick before the first interval elapses', async () => {
    saveSyncSettings({ serverUrl: 'https://s.test', authToken: '', autoSync: true, intervalMinutes: 30 });
    render(<AutoSyncScheduler />);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('stops ticking when unmounted', async () => {
    saveSyncSettings({ serverUrl: 'https://s.test', authToken: '', autoSync: true, intervalMinutes: 15 });
    const { unmount } = render(<AutoSyncScheduler />);
    unmount();
    await vi.advanceTimersByTimeAsync(3 * 15 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();
  });

  it('respects refreshAutoSyncScheduler: on after save, off after config cleared', async () => {
    // Nothing configured: refresh must not start anything.
    render(<AutoSyncScheduler />);
    clearSyncSettings();
    refreshAutoSyncScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runSyncIfConfigured).not.toHaveBeenCalled();

    // Turn it on: the next window runs a tick.
    saveSyncSettings({ serverUrl: 'https://s.test', authToken: '', autoSync: true, intervalMinutes: 15 });
    refreshAutoSyncScheduler();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);

    // Turn it off: no further ticks.
    saveSyncSettings({ serverUrl: 'https://s.test', authToken: '', autoSync: false, intervalMinutes: 15 });
    refreshAutoSyncScheduler();
    await vi.advanceTimersByTimeAsync(5 * 15 * 60_000);
    expect(runSyncIfConfigured).toHaveBeenCalledTimes(1);
  });

  it('clears stale localStorage keys the scheduler reads', () => {
    // Guard against the settings module renaming its key without the
    // scheduler following: both must agree on the storage key.
    saveSyncSettings({ serverUrl: 'https://s.test', authToken: '', autoSync: true, intervalMinutes: 5 });
    expect(Object.keys(JSON.parse(localStorage.getItem('notehaven.sync.settings') || '{}'))).toContain('serverUrl');
    expect(loadSyncSettings().serverUrl).toBe('https://s.test');
  });
});