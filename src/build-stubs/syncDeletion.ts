/**
 * Build-time stub for src/lib/syncDeletion.ts — compiled in ONLY when
 * `VITE_NO_SYNC=1`. `recordDeletion` is called synchronously on every local
 * note deletion (src/hooks/useNotes.ts), so the stub must be a plain no-op:
 * without sync there is no tombstone to record and no server to propagate to.
 */

export interface DeletionInfo {
  uid: string;
  deletedAt: string;
  noteUpdatedAt: string;
}

export function recordDeletion(): void {}

export function withTombstone(
  tombstones: DeletionInfo[],
  deletion: DeletionInfo,
  maxTombstones = 500,
): DeletionInfo[] {
  const next = [...tombstones.filter((t) => t.uid !== deletion.uid), deletion];
  return next.slice(-maxTombstones);
}

export function loadRawTombstones(): DeletionInfo[] {
  return [];
}