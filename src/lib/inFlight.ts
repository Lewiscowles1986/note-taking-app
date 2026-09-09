/**
 * Global in-flight action registry.
 *
 * Long-running user actions (exports, imports, encryption, key generation) are
 * wrapped with `runInFlight`, which:
 *
 *  - tracks them so a non-blocking UI (see `InFlightManager`) can show what is
 *    running and let the user cancel it,
 *  - refuses to double-start a conflicting action in the same group: instead a
 *    registered confirm handler (the dialog in `InFlightManager`) asks whether
 *    to cancel the in-flight action first,
 *  - threads an AbortSignal through the task and discards its result if the
 *    user cancels (callers `catch` the `CancelledError` and stay quiet).
 *
 * Module-level store (same pattern as `use-toast.ts`) so the registry works
 * from anywhere — including outside React render.
 */

export interface InFlightAction {
  id: string;
  /** Human-readable label shown in the indicator, e.g. "Exporting ZIP". */
  label: string;
  /** Actions in the same group conflict with each other (e.g. "export"). */
  group: string;
}

/** Thrown when an action is cancelled (by the user or a newer conflicting one). */
export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'CancelledError';
  }
}

// ─── registry ────────────────────────────────────────────────────────────────

const running = new Map<string, InFlightAction>();
const controllers = new Map<string, AbortController>();
const settled = new Map<string, Promise<void>>();
const EMPTY: InFlightAction[] = [];

let snapshot: InFlightAction[] = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = running.size > 0 ? Array.from(running.values()) : EMPTY;
  for (const listener of listeners) listener();
}

export function subscribeInFlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for `useSyncExternalStore` (never a fresh array). */
export function getInFlightSnapshot(): InFlightAction[] {
  return snapshot;
}

export function isRunningInGroup(group: string): boolean {
  for (const action of running.values()) if (action.group === group) return true;
  return false;
}

// ─── conflict policy ─────────────────────────────────────────────────────────

export type ConflictDecision = 'cancel' | 'keep';
export type ConfirmCancelHandler = (
  existing: InFlightAction,
  incomingLabel: string,
) => Promise<ConflictDecision>;

let confirmCancelHandler: ConfirmCancelHandler | null = null;

/**
 * The UI layer (`InFlightManager`) registers a handler that asks the user,
 * via a dialog, whether the in-flight action should be cancelled to make room
 * for the new one. Passing `null` restores the default (refuse new starts).
 */
export function setConfirmCancelHandler(handler: ConfirmCancelHandler | null): void {
  confirmCancelHandler = handler;
}

// ─── cancellation ────────────────────────────────────────────────────────────

/** Aborts the action's task and discards its result. Resolves when settled. */
export function cancelInFlightAction(id: string): Promise<void> {
  controllers.get(id)?.abort();
  return settled.get(id) ?? Promise.resolve();
}

/** Cancels every running action (used by the "cancel all" affordance). */
export function cancelAllInFlightActions(): Promise<void> {
  return Promise.all([...running.keys()].map(cancelInFlightAction)).then(() => undefined);
}

// ─── the wrapper ─────────────────────────────────────────────────────────────

export interface RunInFlightOptions {
  label: string;
  /** Defaults to `label`. Conflicts are detected per group. */
  group?: string;
}

/**
 * Runs `task` as a tracked, cancellable action.
 *
 * - If another action in the same group is running, the registered confirm
 *   handler decides: cancel it first, or refuse the new start (both rejections
 *   are `CancelledError`, so callers can treat them uniformly and quietly).
 * - The task receives an `AbortSignal`. Operations that cannot be interrupted
 *   (WebCrypto, JSZip) may ignore it; their *result* is still discarded if the
 *   action is cancelled, which is the guarantee the UI relies on.
 *
 * @example
 * await runInFlight({ label: 'Exporting ZIP', group: 'export' }, async () => {
 *   await exportToZip(notes);
 * });
 */
export async function runInFlight<T>(
  options: RunInFlightOptions,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const group = options.group ?? options.label;
  const existing = Array.from(running.values()).find((a) => a.group === group);

  if (existing) {
    let decision: ConflictDecision = 'keep';
    if (confirmCancelHandler) {
      decision = await confirmCancelHandler(existing, options.label);
    }
    if (decision === 'keep') throw new CancelledError();
    await cancelInFlightAction(existing.id);
  }

  const id = `${group}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();

  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  running.set(id, { id, label: options.label, group });
  controllers.set(id, controller);
  settled.set(id, done);
  emit();

  try {
    // Promise.resolve() so a task returning a plain value (or a test double
    // returning undefined) is treated uniformly as a promise.
    const taskPromise = Promise.resolve()
      .then(() => task(controller.signal) as Promise<T> | T);
    // The abandoned task's eventual rejection must not surface as an
    // unhandled error once cancellation has discarded it.
    taskPromise.catch(() => undefined);
    // Settle as soon as the action is cancelled, even when the underlying
    // operation cannot be interrupted (WebCrypto, JSZip): it keeps running,
    // but its result is discarded.
    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new CancelledError());
        return;
      }
      controller.signal.addEventListener('abort', () => reject(new CancelledError()), { once: true });
    });
    const result = await Promise.race([taskPromise, abortPromise]);
    // The task may have finished at the same moment as a cancellation —
    // discard the result either way.
    if (controller.signal.aborted) throw new CancelledError();
    return result;
  } finally {
    running.delete(id);
    controllers.delete(id);
    settled.delete(id);
    settle();
    emit();
  }
}