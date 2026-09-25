/**
 * App-level auto-sync scheduler (multi-server).
 *
 * Mounted once in `App.tsx`. Reads the per-server settings synchronously (a
 * few bytes of localStorage each) and ONLY for servers with auto-sync enabled
 * does it dynamically import the sync engine and start a background interval
 * — ONE interval per configured server, each on its own cadence.
 * Never-configured users never load the engine; auto-sync users load it
 * lazily after first paint.
 *
 * The intervals live across route/mode changes because they hang off App, not
 * the servers page — auto-sync keeps working while the user is editing.
 */

import { useEffect } from 'react';
import { listServers, getServerSettings } from '@/lib/syncServers';

/** Started-interval bookkeeping so HMR/strict-mode double-mounts don't stack timers. */
const stopFns = new Map<string, () => void>();
/** Generation counter: a queued start is ignored if a newer stop superseded it. */
let generation = 0;

function startScheduler(): void {
  if (stopFns.size > 0) return;
  // One interval PER server with autoSync enabled; servers without it are
  // skipped entirely (their tick would be a no-op anyway, and skipping keeps
  // manual-only servers from loading the engine at all).
  for (const server of listServers()) {
    const settings = getServerSettings(server.id);
    if (!settings.autoSync) continue;
    const minutes = Math.max(1, Math.round(settings.intervalMinutes) || 15);
    const serverId = server.id;
    let timer: number | undefined;

    const tick = () => {
      // Dynamic import: the engine (and its ~15 KB) only downloads for users
      // who opted into a server. runSyncIfConfigured never throws.
      void import('./sync').then(({ runSyncIfConfigured }) => runSyncIfConfigured(serverId));
    };

    timer = window.setInterval(tick, minutes * 60_000);
    stopFns.set(serverId, () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      stopFns.delete(serverId);
    });
  }
}

/**
 * React to configuration changes: start when auto-sync turns on (or the
 * interval/server changes), stop when it turns off or the config is cleared.
 * Runs on a microtask so `saveSyncSettings` inside the same task is visible.
 * A queued start is invalidated by any newer stop (e.g. an unmount that
 * happens before the microtask runs).
 */
export function refreshAutoSyncScheduler(): void {
  const gen = ++generation;
  queueMicrotask(() => {
    if (gen !== generation) return; // superseded (stopped/unmounted meanwhile)
    for (const stop of stopFns.values()) stop();
    startScheduler();
  });
}

function stopNow(): void {
  generation++; // invalidate any queued start
  for (const stop of stopFns.values()) stop();
}

/** Which storage keys the scheduler reacts to (per-server settings keys). */
export function isSchedulerStorageKey(key: string | null): boolean {
  if (key === null) return true; // key === null: clear() touched everything
  return key.startsWith('notehaven.sync.server.');
}

/**
 * Mount-point component: subscribes to settings changes via the `storage`
 * event (cross-tab) and picks up same-tab saves through the explicit refresh
 * call from the settings page. Nothing renders.
 */
export default function AutoSyncScheduler() {
  useEffect(() => {
    refreshAutoSyncScheduler();
    const onStorage = (e: StorageEvent) => {
      if (isSchedulerStorageKey(e.key)) refreshAutoSyncScheduler();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      stopNow();
    };
  }, []);
  return null;
}