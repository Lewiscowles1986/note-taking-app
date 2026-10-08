import posthog from '@/lib/posthog';

interface SyncLogOutcome {
  ok: boolean;
  pushed: number;
  pulled: number;
  deletedLocal: number;
  deletedRemote: number;
  errors: string[];
}

export function logSyncOutcome(result: SyncLogOutcome): void {
  const attributes = {
    event: 'sync.round.completed',
    outcome: result.ok ? 'success' : 'partial_failure',
    pushed_count: result.pushed,
    pulled_count: result.pulled,
    deleted_local_count: result.deletedLocal,
    deleted_remote_count: result.deletedRemote,
    error_count: result.errors.length,
  };

  if (result.ok) {
    posthog.logger.info('sync round completed', attributes);
  } else {
    posthog.logger.warn('sync round completed with problems', attributes);
  }
}

export function logSyncFailure(): void {
  posthog.logger.error('sync round failed', { event: 'sync.round.failed' });
}
