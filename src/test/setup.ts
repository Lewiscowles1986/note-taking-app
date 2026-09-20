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

// Node ≥25 defines a global `localStorage` object ALWAYS, but its methods are
// all undefined unless --localstorage-file is passed; Node 26's is simply
// undefined. Either way the broken Node global shadows jsdom's working
// implementation in vitest workers, leaving tests without any storage.
// Restore jsdom's (or a minimal in-memory Storage) unless the existing value
// is a genuinely functional Storage — same polyfill pattern as matchMedia
// above. Also fixes `window.localStorage`, which jsdom wires to the same
// implementation instance.
function isUsableStorage(value: unknown): value is Storage {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Storage).getItem === "function" &&
    typeof (value as Storage).setItem === "function" &&
    typeof (value as Storage).clear === "function"
  );
}

function polyfillStorage(target: typeof globalThis): void {
  const existing = (target as { localStorage?: unknown }).localStorage;
  if (isUsableStorage(existing)) return;
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => (backing.has(key) ? backing.get(key)! : null),
    key: (index) => Array.from(backing.keys())[index] ?? null,
    removeItem: (key) => {
      backing.delete(key);
    },
    setItem: (key, value) => {
      backing.set(String(key), String(value));
    },
  };
  Object.defineProperty(target, "localStorage", { configurable: true, value: storage });
}
polyfillStorage(globalThis);
polyfillStorage(window);

// jsdom 20 has no ResizeObserver; chart/panel components instantiate one on mount.
class ResizeObserverStub implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
polyfill("ResizeObserver", ResizeObserverStub);