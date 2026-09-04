import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "../hooks/use-mobile";

type ChangeListener = (event: MediaQueryListEvent) => void;

// jsdom exposes innerWidth as a getter; remember the descriptor so it can be restored.
const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");

const setInnerWidth = (width: number) => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
};

// Replace the setup.ts matchMedia stub with a controllable fake that captures
// the registered change listeners so tests can fire them manually.
function spyMatchMedia() {
  const changeListeners: ChangeListener[] = [];
  const removedListeners: ChangeListener[] = [];
  const matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (typeof listener === "function") changeListeners.push(listener as ChangeListener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (typeof listener === "function") removedListeners.push(listener as ChangeListener);
      },
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
  return { matchMediaSpy, changeListeners, removedListeners };
}

const fireChange = (listeners: ChangeListener[]) => {
  act(() => {
    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
  });
};

describe("useIsMobile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalInnerWidth) {
      Object.defineProperty(window, "innerWidth", originalInnerWidth);
    } else {
      delete (window as { innerWidth?: unknown }).innerWidth;
    }
  });

  it("reports false on a desktop-sized viewport", () => {
    setInnerWidth(1280);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it("reports true when the viewport is narrower than the 768px breakpoint", () => {
    setInnerWidth(500);
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
  });

  it("re-evaluates from window.innerWidth when the media query emits change events", () => {
    const { matchMediaSpy, changeListeners } = spyMatchMedia();
    setInnerWidth(375);

    const { result } = renderHook(() => useIsMobile());

    // The initial value derives from window.innerWidth even though the fake
    // media query always reports matches: false.
    expect(result.current).toBe(true);

    setInnerWidth(1280);
    fireChange(changeListeners);
    expect(result.current).toBe(false);

    setInnerWidth(600);
    fireChange(changeListeners);
    expect(result.current).toBe(true);

    expect(matchMediaSpy).toHaveBeenCalledWith("(max-width: 767px)");
  });

  it("unsubscribes the change listener on unmount", () => {
    const { changeListeners, removedListeners } = spyMatchMedia();
    const { result, unmount } = renderHook(() => useIsMobile());
    expect(changeListeners).toHaveLength(1);

    unmount();

    expect(removedListeners).toHaveLength(1);
    expect(removedListeners[0]).toBe(changeListeners[0]);
    expect(result.current).toBe(false);
  });
});