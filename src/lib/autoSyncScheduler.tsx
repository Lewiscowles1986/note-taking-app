/**
 * App-level auto-sync scheduler (multi-server) — mount-point component.
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
 *
 * The imperative machinery (intervals, refresh, storage-key predicate) lives
 * in `autoSyncSchedulerControl.ts` so this file exports ONLY the component
 * (react fast-refresh requires it).
 */

import { useEffect } from 'react';
import {
  isSchedulerStorageKey,
  refreshAutoSyncScheduler,
  stopAutoSyncScheduler,
} from './autoSyncSchedulerControl';

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
      stopAutoSyncScheduler();
    };
  }, []);
  return null;
}