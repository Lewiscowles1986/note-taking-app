/**
 * Non-blocking UI for in-flight actions.
 *
 * - Shows every running action (label + spinner) in a corner stack — pure
 *   status, never a modal overlay, so the UI stays usable while work runs.
 *   Each row can be cancelled.
 * - Registers the global conflict handler: when a second action in the same
 *   group starts, an AlertDialog asks whether to cancel the running one.
 *
 * Mounted once, in `App.tsx`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  getInFlightSnapshot,
  subscribeInFlight,
  cancelInFlightAction,
  setConfirmCancelHandler,
  type ConflictDecision,
  type InFlightAction,
} from '@/lib/inFlight';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface PendingQuestion {
  existing: InFlightAction;
  incomingLabel: string;
  resolve: (decision: ConflictDecision) => void;
}

export default function InFlightManager() {
  const actions = useInFlightActions();
  const [question, setQuestion] = useState<PendingQuestion | null>(null);

  // The registry needs a decision-maker for conflicting actions. One handler
  // is registered for the app's lifetime; it resolves through component state.
  useEffect(() => {
    setConfirmCancelHandler(
      (existing, incomingLabel) =>
        new Promise<ConflictDecision>((resolve) => {
          setQuestion({ existing, incomingLabel, resolve });
        }),
    );
    return () => setConfirmCancelHandler(null);
  }, []);

  const answer = useCallback((decision: ConflictDecision) => {
    setQuestion((current) => {
      current?.resolve(decision);
      return null;
    });
  }, []);

  return (
    <>
      {actions.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
          data-testid="inflight-indicator"
        >
          {actions.map((action) => (
            <div
              key={action.id}
              className="flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-md"
            >
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
              <span>{action.label}…</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={`Cancel ${action.label}`}
                onClick={() => void cancelInFlightAction(action.id)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={question !== null}
        onOpenChange={(open) => {
          if (!open) answer('keep');
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Another {question?.existing.label ?? 'action'} is running</AlertDialogTitle>
            <AlertDialogDescription>
              {question
                ? `"${question.incomingLabel}" can't run while "${question.existing.label}" is in progress. Cancel the running action and start the new one?`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => answer('keep')}>No, wait</AlertDialogCancel>
            <AlertDialogAction onClick={() => answer('cancel')}>
              Cancel it and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Keep the store subscription at the bottom: hooks after logic reads better here.

function useInFlightActions(): InFlightAction[] {
  const [actions, setActions] = useState<InFlightAction[]>(getInFlightSnapshot);
  useEffect(() => subscribeInFlight(() => setActions(getInFlightSnapshot())), []);
  return actions;
}