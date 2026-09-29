/**
 * Build-time stub for src/lib/syncNotifications.ts — compiled in ONLY when
 * `VITE_NO_SYNC=1`. The header bell (SyncNotifications.tsx) and the
 * never-delete queue disappear in a no-sync build, so every export collapses
 * to its empty form; `resolveNotification` never resolves a real prompt.
 */

/** Same string as the real module — listeners subscribe to the same event. */
export const SYNC_NOTIFICATIONS_EVENT = 'notehaven:sync-notifications';

export type SyncNotificationKind = 'remote-delete';

export interface SyncNotification {
  id: string;
  serverId: string;
  uid: string;
  title: string;
  category: string;
  deletedAt: string;
  queuedAt: string;
  kind?: SyncNotificationKind;
}

export interface RemoteDeletionInfo {
  serverId: string;
  uid: string;
  title: string;
  category: string;
  deletedAt: string;
  kind?: SyncNotificationKind;
}

export function getPendingNotifications(): SyncNotification[] {
  return [];
}

export function getAllPendingNotifications(): SyncNotification[] {
  return [];
}

export function isQueued(): boolean {
  return false;
}

export function enqueueRemoteDeletion(): SyncNotification | null {
  return null;
}

export function removeNotification(): void {}

export type NotificationDecision = 'keep' | 'delete';

export async function resolveNotification(): Promise<void> {}

export function hasKeepException(): boolean {
  return false;
}

export function addKeepException(): void {}

export function getKeepExceptionUids(): string[] {
  return [];
}

export function wouldPromptBeSuppressed(): boolean {
  return false;
}