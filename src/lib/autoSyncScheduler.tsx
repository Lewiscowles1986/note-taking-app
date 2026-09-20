/**
 * App-level auto-sync scheduler.
 *
 * Mounted once in `App.tsx`. Reads the stored settings synchronously (a few
 * bytes of localStorage) and ONLY when a server is actually configured does
 * it dynamically import the sync engine and start the background interval.
 * Never-configured users never load the engine; auto-sync users load it
 * lazily after first paint.
 *
 * The interval lives across route/mode changes because it hangs off App, not
 * the settings page — auto-sync keeps working while the user is editing.
 */

import { useEffect } from 'react';
import { loadSyncSettings } from '@/lib/syncSettings';

/** Started-interval bookkeeping so HMR/strict-mode double-mounts don't stack timers. */
let stopScheduler: (() => void) | null = null;
/** Generation counter: a queued start is ignored if a newer stop superseded it. */
let generation = 0;

function startScheduler(): void {
  if (stopScheduler) return;
  const settings = loadSyncSettings();
  if (!settings.autoSync || !settings.serverUrl) return;
  const minutes = Math.max(1, Math.round(settings.intervalMinutes) || 15);
  let timer: number | undefined;
  let cancelled = false;

  const tick = () => {
    // Dynamic import: the engine (and its ~15 KB) only downloads for users
    // who opted into a server. runSyncIfConfigured never throws.
    void import('./sync').then(({ runSyncIfConfigured }) => runSyncIfConfigured());
  };

  timer = window.setInterval(tick, minutes * 60_000);
  stopScheduler = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    stopScheduler = null;
  };
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
    stopScheduler?.();
    stopScheduler = null;
    startScheduler();
  });
}

function stopNow(): void {
  generation++; // invalidate any queued start
  stopScheduler?.();
  stopScheduler = null;
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
      if (e.key === 'notehaven.sync.settings' || e.key === null) {
        refreshAutoSyncScheduler();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      stopNow();
    };
  }, []);
  return null;
}