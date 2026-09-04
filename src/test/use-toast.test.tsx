import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reducer, toast, useToast } from "@/hooks/use-toast";

type ToastHandle = ReturnType<typeof toast>;

/** Removal delay hardcoded in use-toast.ts (TOAST_REMOVE_DELAY = 1_000_000 ms). */
const TOAST_REMOVE_DELAY = 1_000_000;

/**
 * The toast store is module-level singleton state shared by every test in this
 * file. Each test renders its own hook and the afterEach hook drains the store
 * (dismiss everything, then fire the remove timers) so tests stay
 * order-independent regardless of which toasts they left behind.
 */
let lastResult: { current: ReturnType<typeof useToast> } | undefined;

function renderToastHook() {
  const hook = renderHook(() => useToast());
  lastResult = hook.result;
  return hook;
}

describe("use-toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      lastResult?.current.dismiss();
    });
    act(() => {
      vi.runAllTimers();
    });
    vi.useRealTimers();
    lastResult = undefined;
  });

  describe("useToast hook", () => {
    it("starts with no toasts and exposes a freshly added one", () => {
      const hook = renderToastHook();

      expect(hook.result.current.toasts).toEqual([]);

      let handle: ToastHandle | undefined;
      act(() => {
        handle = hook.result.current.toast({ title: "Saved", description: "Note stored" });
      });

      expect(hook.result.current.toasts).toHaveLength(1);
      const added = hook.result.current.toasts[0];
      expect(added.id).toBe(handle?.id);
      expect(added.title).toBe("Saved");
      expect(added.description).toBe("Note stored");
      expect(added.open).toBe(true);
      expect(typeof added.onOpenChange).toBe("function");
    });

    it("keeps only the newest toast (TOAST_LIMIT = 1) and stale handles no-op", () => {
      const hook = renderToastHook();

      let first: ToastHandle | undefined;
      let second: ToastHandle | undefined;
      act(() => {
        first = hook.result.current.toast({ title: "first" });
      });
      act(() => {
        second = hook.result.current.toast({ title: "second" });
      });

      expect(hook.result.current.toasts).toHaveLength(1);
      expect(hook.result.current.toasts[0].title).toBe("second");
      expect(hook.result.current.toasts[0].id).toBe(second?.id);

      // A handle for an evicted toast must not corrupt the survivor.
      act(() => {
        first?.update({ id: first.id, title: "zombie" });
      });
      expect(hook.result.current.toasts[0].title).toBe("second");

      act(() => {
        first?.dismiss();
      });
      expect(hook.result.current.toasts[0].open).toBe(true);
    });

    it("update rewrites the active toast through the returned handle", () => {
      const hook = renderToastHook();

      let handle: ToastHandle | undefined;
      act(() => {
        handle = hook.result.current.toast({ title: "before" });
      });
      act(() => {
        handle?.update({ id: handle.id, title: "after", description: "rewritten" });
      });

      expect(hook.result.current.toasts[0].title).toBe("after");
      expect(hook.result.current.toasts[0].description).toBe("rewritten");
      expect(hook.result.current.toasts[0].id).toBe(handle?.id);
    });

    it("handle.dismiss closes the toast, is idempotent, then removes it after the remove delay", () => {
      const hook = renderToastHook();

      let handle: ToastHandle | undefined;
      act(() => {
        handle = hook.result.current.toast({ title: "temporary" });
      });

      act(() => {
        handle?.dismiss();
      });
      expect(hook.result.current.toasts).toHaveLength(1);
      expect(hook.result.current.toasts[0].open).toBe(false);

      // A second dismiss must not schedule a duplicate removal timer.
      act(() => {
        handle?.dismiss();
      });

      act(() => {
        vi.advanceTimersByTime(TOAST_REMOVE_DELAY - 1);
      });
      expect(hook.result.current.toasts).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(hook.result.current.toasts).toHaveLength(0);
    });

    it("hook dismiss() without an id closes everything and then the store empties", () => {
      const hook = renderToastHook();

      act(() => {
        hook.result.current.toast({ title: "only" });
      });
      act(() => {
        hook.result.current.dismiss();
      });

      expect(hook.result.current.toasts).toHaveLength(1);
      expect(hook.result.current.toasts[0].open).toBe(false);

      act(() => {
        vi.advanceTimersByTime(TOAST_REMOVE_DELAY);
      });
      expect(hook.result.current.toasts).toHaveLength(0);
    });

    it("onOpenChange(false) dismisses; onOpenChange(true) is a no-op", () => {
      const hook = renderToastHook();

      act(() => {
        hook.result.current.toast({ title: "interactive" });
      });
      const added = hook.result.current.toasts[0];

      act(() => {
        added.onOpenChange?.(true);
      });
      expect(hook.result.current.toasts[0].open).toBe(true);

      act(() => {
        added.onOpenChange?.(false);
      });
      expect(hook.result.current.toasts[0].open).toBe(false);

      act(() => {
        vi.advanceTimersByTime(TOAST_REMOVE_DELAY);
      });
      expect(hook.result.current.toasts).toHaveLength(0);
    });

    it("stops listening after unmount", () => {
      const hook = renderToastHook();

      act(() => {
        hook.result.current.toast({ title: "kept" });
      });
      expect(hook.result.current.toasts).toHaveLength(1);

      hook.unmount();

      // Dispatching with no registered listeners must not throw.
      act(() => {
        toast({ title: "after unmount" });
      });
    });
  });

  describe("toast reducer", () => {
    // The reducer is exported, so its branches can be driven directly —
    // including the REMOVE_TOAST-without-id branch that no public helper
    // produces on its own.
    it("REMOVE_TOAST without an id clears every toast", () => {
      const state = { toasts: [{ id: "a", open: true }, { id: "b", open: false }] };
      expect(reducer(state, { type: "REMOVE_TOAST" })).toEqual({ toasts: [] });
    });

    it("REMOVE_TOAST with an id filters only that toast", () => {
      const state = { toasts: [{ id: "a", open: true }, { id: "b", open: true }] };
      const next = reducer(state, { type: "REMOVE_TOAST", toastId: "a" });
      expect(next.toasts.map((t) => t.id)).toEqual(["b"]);
    });

    it("ADD_TOAST prepends the new toast and enforces TOAST_LIMIT", () => {
      const state = { toasts: [{ id: "a", open: true }, { id: "b", open: true }] };
      const next = reducer(state, { type: "ADD_TOAST", toast: { id: "c", open: true } });
      expect(next.toasts.map((t) => t.id)).toEqual(["c"]);
      expect(next.toasts[0].open).toBe(true);
    });

    it("UPDATE_TOAST merges into the matching toast only", () => {
      const state = { toasts: [{ id: "a", open: true, title: "old" }, { id: "b", open: true }] };

      const matching = reducer(state, { type: "UPDATE_TOAST", toast: { id: "a", title: "new" } });
      expect(matching.toasts[0].title).toBe("new");
      expect(matching.toasts[0].open).toBe(true);

      const nonMatching = reducer(state, { type: "UPDATE_TOAST", toast: { id: "zzz", title: "ignored" } });
      expect(nonMatching.toasts[0].title).toBe("old");
      expect(nonMatching.toasts[1].title).toBeUndefined();
    });

    it("DISMISS_TOAST closes the matching toast and queues its removal", () => {
      const state = { toasts: [{ id: "a", open: true }, { id: "b", open: true }] };
      const next = reducer(state, { type: "DISMISS_TOAST", toastId: "a" });
      expect(next.toasts[0].open).toBe(false);
      expect(next.toasts[1].open).toBe(true);
    });

    it("DISMISS_TOAST without an id closes every toast", () => {
      const state = { toasts: [{ id: "a", open: true }, { id: "b", open: true }] };
      const next = reducer(state, { type: "DISMISS_TOAST" });
      expect(next.toasts.map((t) => t.open)).toEqual([false, false]);
    });
  });
});