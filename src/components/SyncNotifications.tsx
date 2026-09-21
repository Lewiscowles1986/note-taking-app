import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  SYNC_NOTIFICATIONS_EVENT,
  getPendingNotifications,
  resolveNotification,
  type SyncNotification,
} from '@/lib/syncNotifications';

/**
 * Queued keep-or-delete prompts for notes the SERVER deleted (the client
 * never deletes on its own — docs/sync.md, "Never-delete policy").
 *
 * An inline bell in the header icon cluster (beside Calendar/Settings) shows
 * the pending count; the panel lists each queued note with its title,
 * category and deletion date plus the two actions: Keep on this device
 * (permanent exception for this browser profile) and Delete from this device
 * (explicit user-commanded removal).
 *
 * Rendered inline by each top-level surface's header (Index, SettingsPage) —
 * never a bar of its own. It has no sync-engine dependency, which stays
 * behind a dynamic import in resolveNotification.
 */

const formatDate = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : 'unknown date';
};

export default function SyncNotifications() {
  const [pending, setPending] = useState<SyncNotification[]>(() => getPendingNotifications());
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setPending(getPendingNotifications());
    window.addEventListener(SYNC_NOTIFICATIONS_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(SYNC_NOTIFICATIONS_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const decide = useCallback(async (entry: SyncNotification, decision: 'keep' | 'delete') => {
    setBusyId(entry.id);
    try {
      await resolveNotification(entry.id, decision);
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sync-notifications-trigger"
          title="Sync notifications"
          aria-label={`Sync notifications (${pending.length} pending)`}
          className="relative p-2 min-w-11 min-h-11 flex items-center justify-center rounded-md hover:bg-accent text-muted-foreground transition-colors sm:min-w-min sm:min-h-min sm:p-1.5"
        >
          <Bell size={16} aria-hidden="true" />
          {pending.length > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
              data-testid="sync-notifications-count"
            >
              {pending.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="sync-notifications-panel">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <TriangleAlert size={14} className="text-amber-600" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">Remote deletions</span>
          {pending.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {pending.length}
            </Badge>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            Nothing pending. Notes deleted on the server are never removed here without your
            explicit choice.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto divide-y divide-border">
            {pending.map((entry) => (
              <li key={entry.uid} data-testid={`sync-queue-item-${entry.uid}`} className="px-3 py-2.5 space-y-2">
                <div>
                  <p className="text-sm font-medium text-foreground truncate">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.category} · deleted {formatDate(entry.deletedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busyId !== null}
                    onClick={() => void decide(entry, 'keep')}
                    data-testid={`sync-keep-${entry.uid}`}
                  >
                    <Check size={12} className="mr-1" aria-hidden="true" />
                    Keep on this device
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busyId === entry.id}
                    onClick={() => void decide(entry, 'delete')}
                    data-testid={`sync-delete-${entry.uid}`}
                  >
                    <Trash2 size={12} className="mr-1" aria-hidden="true" />
                    Delete from this device
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}