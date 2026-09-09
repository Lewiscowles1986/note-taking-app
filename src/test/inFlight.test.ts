// Tests for the global in-flight action registry (src/lib/inFlight.ts):
// tracking, conflict handling with a registered decision-maker, cancellation
// semantics (result discarded even when the underlying task cannot be
// interrupted), and clean re-entrancy after settle.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CancelledError,
  cancelInFlightAction,
  getInFlightSnapshot,
  isRunningInGroup,
  runInFlight,
  setConfirmCancelHandler,
  subscribeInFlight,
} from '@/lib/inFlight';

afterEach(() => {
  setConfirmCancelHandler(null);
});

describe('registry basics', () => {
  it('exposes a running action via the snapshot while it runs', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const promise = runInFlight({ label: 'Exporting ZIP', group: 'export' }, async () => {
      await gate;
    });
    expect(getInFlightSnapshot()).toHaveLength(1);
    expect(getInFlightSnapshot()[0]).toMatchObject({ label: 'Exporting ZIP', group: 'export' });
    expect(isRunningInGroup('export')).toBe(true);

    release?.();
    await promise;
    expect(getInFlightSnapshot()).toHaveLength(0);
    expect(isRunningInGroup('export')).toBe(false);
  });

  it('notifies subscribers on start and settle', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInFlight(listener);

    await runInFlight({ label: 'Working', group: 'g1' }, async () => undefined);

    expect(listener).toHaveBeenCalledTimes(2); // start + settle
    unsubscribe();
  });

  it('resolves results and propagates task errors', async () => {
    await expect(runInFlight({ label: 'Ok' }, () => Promise.resolve('value'))).resolves.toBe('value');
    await expect(runInFlight({ label: 'Boom' }, () => Promise.reject(new Error('kaboom')))).rejects.toThrow(
      'kaboom',
    );
  });
});

describe('conflict policy', () => {
  it('refuses a second action in the same group without a handler', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = runInFlight({ label: 'First', group: 'export' }, () => gate);

    await expect(runInFlight({ label: 'Second', group: 'export' }, async () => 'never')).rejects.toThrow(
      CancelledError,
    );

    release?.();
    await first;
  });

  it('asks the registered handler and cancels the running action when approved', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taskSignal: AbortSignal | undefined;

    const first = runInFlight({ label: 'First export', group: 'export' }, (signal) => {
      taskSignal = signal;
      signal.addEventListener('abort', () => release?.());
      return gate;
    });
    expect(first).toBeInstanceOf(Promise);

    setConfirmCancelHandler(() => Promise.resolve('cancel'));

    // The second action proceeds after the first was cancelled.
    const second = runInFlight({ label: 'Second export', group: 'export' }, async () => 'second result');
    await expect(second).resolves.toBe('second result');
    await expect(first).rejects.toThrow(CancelledError);
    expect(taskSignal?.aborted).toBe(true);
  });

  it('refuses the new start when the handler says keep', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = runInFlight({ label: 'Keep me', group: 'export' }, () => gate);

    setConfirmCancelHandler(() => Promise.resolve('keep'));

    await expect(runInFlight({ label: 'Blocked', group: 'export' }, async () => 'nope')).rejects.toThrow(
      CancelledError,
    );
    expect(isRunningInGroup('export')).toBe(true); // first still running

    release?.();
    await first;
  });

  it('passes labels and the existing action to the handler', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = runInFlight({ label: 'Running one', group: 'export' }, () => gate);

    const handler = vi.fn(() => Promise.resolve('keep' as const));
    setConfirmCancelHandler(handler);

    await expect(runInFlight({ label: 'Incoming one', group: 'export' }, async () => 1)).rejects.toThrow();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ label: 'Running one' }), 'Incoming one');

    release?.();
    await first;
  });

  it('allows parallel actions in different groups', async () => {
    const a = runInFlight({ label: 'Export', group: 'export' }, async () => 'a');
    const b = runInFlight({ label: 'Encrypt', group: 'encryption' }, async () => 'b');
    await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b']);
  });
});

describe('cancellation semantics', () => {
  it('discards the result of a task that finishes after cancellation', async () => {
    let cancelled = false;
    const finished = new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 5);
    });

    const promise = runInFlight({ label: 'Slow', group: 'g' }, (signal) => {
      // The abort may land before the task's first microtask runs, so observe
      // both the pre-aborted state and the abort event.
      if (signal.aborted) {
        cancelled = true;
        return finished;
      }
      signal.addEventListener('abort', () => (cancelled = true), { once: true });
      return finished;
    });
    await cancelInFlightAction(getInFlightSnapshot()[0].id);
    await expect(promise).rejects.toThrow(CancelledError);
    expect(cancelled).toBe(true);
    expect(getInFlightSnapshot()).toHaveLength(0);
  });

  it('aborts the signal delivered to the task', async () => {
    let signal: AbortSignal | undefined;
    const promise = runInFlight({ label: 'Watched', group: 'g' }, (sig) => {
      signal = sig;
      return new Promise(() => {}); // never settles on its own
    });

    await cancelInFlightAction(getInFlightSnapshot()[0].id);
    await expect(promise).rejects.toThrow(CancelledError);
    expect(signal?.aborted).toBe(true);
  });

  it('cancelling an unknown id is a no-op', async () => {
    await expect(cancelInFlightAction('no-such-id')).resolves.toBeUndefined();
  });
});