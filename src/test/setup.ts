import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

// jsdom does not implement matchMedia; components (theme toggles, charts) query it.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

/**
 * Define `name` on globalThis and the jsdom window, but only when it is
 * missing — never clobber a working implementation.
 */
function polyfill(name: string, value: unknown): void {
  if (typeof Reflect.get(globalThis, name) === "undefined") {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  if (typeof Reflect.get(window, name) === "undefined") {
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }
}

// jsdom 20's crypto lacks subtle/randomUUID; fall back to Node's WebCrypto.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    writable: true,
    value: webcrypto,
  });
}
if (!window.crypto?.subtle) {
  Object.defineProperty(window, "crypto", {
    configurable: true,
    writable: true,
    value: webcrypto,
  });
}

// jsdom 20 lacks TextEncoder/TextDecoder; Node ships spec-compliant ones.
polyfill("TextEncoder", TextEncoder);
polyfill("TextDecoder", TextDecoder);

// jsdom 20 has no Blob.prototype.text (File.text inherits it); read via FileReader.
if (typeof Blob !== "undefined" && typeof Blob.prototype.text !== "function") {
  Object.defineProperty(Blob.prototype, "text", {
    configurable: true,
    writable: true,
    value(this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(reader.error ?? new Error("Blob.text: read failed"));
        reader.readAsText(this);
      });
    },
  });
}

// jsdom 20 exposes no navigator.clipboard; minimal promise-returning stub.
if (!navigator.clipboard) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: () => Promise.resolve(""),
      writeText: () => Promise.resolve(undefined),
    },
  });
}

// jsdom 20 has no ResizeObserver; chart/panel components instantiate one on mount.
class ResizeObserverStub implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
polyfill("ResizeObserver", ResizeObserverStub);