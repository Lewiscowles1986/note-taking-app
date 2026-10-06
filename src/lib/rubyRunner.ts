/**
 * Sandboxed CRuby executor via WebAssembly.
 *
 * One vendored bundle per Ruby line under /ruby-wasm/build-<directory>/, each
 * with a vendor.json describing its loader module, exported entry point and
 * which assets are gzipped. Two integration families exist: modern upstream
 * ruby.wasm bundles export `createVM` (a RubyVM reactor), while the historical
 * Emscripten ports export `runCommand` (a command that evaluates supplied
 * source).
 */

import { registerVersionedRunner, setRunnerAvailability } from './codeRunners';
import { loadAsset, loadVendorManifest, loadWasmIndex, type WasmIndex } from './wasmAssets';

export interface RubyBundle {
  version: string;
  directory: string;
}

/**
 * Fallback list for when the generated catalog cannot be fetched (offline
 * first load, or a stale deployment). The catalog is authoritative; this only
 * keeps the selector usable when it is unavailable.
 */
export const RUBY_BUNDLES: RubyBundle[] = [
  { version: '1.0-971225', directory: '1.0-971225' },
  { version: '1.1d1', directory: '1.1d1' },
  { version: '1.2', directory: '1.2' },
  { version: '1.2.6', directory: '1.2.6' },
  { version: '1.3', directory: '1.3' },
  { version: '1.3.7', directory: '1.3.7' },
  { version: '1.4.0', directory: '1.4.0' },
  { version: '1.4.6', directory: '1.4.6' },
  { version: '1.5.0', directory: '1.5.0' },
  { version: '1.6.8', directory: '1.6.8' },
  { version: '1.7.1', directory: '1.7.1' },
  { version: '1.8.0', directory: '1.8.0' },
  { version: '1.8.7', directory: '1.8.7-p374' },
  { version: '2.3.8', directory: '2.3.8' },
  { version: '2.4.10', directory: '2.4.10' },
  { version: '2.5.0', directory: '2.5.0' },
  { version: '2.5.9', directory: '2.5.9' },
  { version: '2.7.8', directory: '2.7.8' },
  { version: '3.0.7', directory: '3.0.7' },
  { version: '3.1.7', directory: '3.1.7' },
  { version: '3.2.4', directory: '3.2' },
  { version: '3.2.0', directory: '3.2.0' },
  { version: '3.2.11', directory: '3.2.11' },
  { version: '3.3.3', directory: '3.3' },
  { version: '3.4.1', directory: '3.4' },
  { version: '4.0.0', directory: '4.0' },
];
export const RUBY_VERSIONS = RUBY_BUNDLES.map((b) => b.version);
export const DEFAULT_RUBY_VERSION = RUBY_VERSIONS[RUBY_VERSIONS.length - 1];
export const REQUIRED_RUBY_VERSIONS = [DEFAULT_RUBY_VERSION] as const;

export type RubyVersion = string;

let catalog: WasmIndex | null = null;

async function directoryFor(version: string): Promise<string> {
  if (!catalog) {
    try {
      catalog = await loadWasmIndex('ruby');
    } catch {
      catalog = { schema: 1, language: 'ruby', latest: DEFAULT_RUBY_VERSION, bundles: RUBY_BUNDLES };
    }
  }
  return catalog.bundles.find((b) => b.version === version)?.directory ?? version;
}

type RubyOutput = (stream: 'stdout' | 'stderr', text: string) => void;

interface RubyVM {
  eval(code: string): { toString(): string };
}

interface RubyAdapter {
  createVM?: (bytes: Uint8Array, output: RubyOutput, stdin?: string) => Promise<{ vm: RubyVM; flush(): void }>;
  runCommand?: (bytes: Uint8Array, output: RubyOutput, source: string, stdin?: string) => Promise<unknown>;
}

let availabilityCache: string[] | null = null;

export async function checkRubyVersionAvailable(version: string): Promise<boolean> {
  const base = import.meta.env.BASE_URL || '/';
  try {
    const res = await fetch(`${base}ruby-wasm/build-${await directoryFor(version)}/vendor.json`, {
      method: 'HEAD',
    });
    return res.ok;
  } catch {
    return true;
  }
}

/**
 * The versions the code block offers. Prefers the generated catalog so a newly
 * vendored bundle appears without a code change; falls back to the bundled list
 * if the catalog cannot be read, dropping any bundle that fails its HEAD probe.
 */
export async function getAvailableRubyVersions(): Promise<string[]> {
  if (availabilityCache) return availabilityCache;
  let bundles: RubyBundle[];
  try {
    const index = await loadWasmIndex('ruby');
    bundles = index.bundles.length > 0 ? index.bundles : RUBY_BUNDLES;
  } catch {
    bundles = RUBY_BUNDLES;
  }
  const results = await Promise.all(
    bundles.map(async (b) => ({ v: b.version, ok: await checkRubyVersionAvailable(b.version) })),
  );
  availabilityCache = results.filter((r) => r.ok).map((r) => r.v);
  return availabilityCache;
}

export function createRubyRunner() {
  return async (code: string, options?: { version?: string }): Promise<string> => {
    const version = options?.version ?? DEFAULT_RUBY_VERSION;
    const base = import.meta.env.BASE_URL || '/';
    const directory = await directoryFor(version);
    const dir = `${base}ruby-wasm/build-${directory}/`;

    const manifest = await loadVendorManifest(dir);
    const bytes = await loadAsset(dir, 'ruby.wasm', manifest);
    // Both integration families export their entry point from runtime.mjs (the
    // historical one is a dependency of the module, not the entry point). A
    // literal filename in the specifier keeps the dev server from appending its
    // `?import` query, which 500s for files under public/.
    const adapter = (await import(
      /* @vite-ignore */ `${base}ruby-wasm/build-${directory}/runtime.mjs`
    )) as RubyAdapter;

    const output: string[] = [];
    const send: RubyOutput = (stream, text) => {
      if (!text) return;
      // stderr is not failure: the yarv-port builds (2.3-2.5) print a benign
      // "pthread_create failed for timer" warning there on every run, and a
      // Ruby program can still write to it and exit 0. Label it as a warning
      // rather than an error; a run that actually fails rejects below.
      output.push(stream === 'stderr' ? `[stderr] ${text}` : text);
    };

    if (typeof adapter.runCommand === 'function') {
      await adapter.runCommand(bytes, send, code, '');
    } else if (typeof adapter.createVM === 'function') {
      const runtime = await adapter.createVM(bytes, send, '');
      try {
        runtime.vm.eval(code);
        runtime.flush();
      } catch (err) {
        try {
          runtime.flush();
        } catch {
          // A trap can leave the stream broken; keep the first error.
        }
        throw err;
      }
    } else {
      throw new Error(`Ruby ${version} bundle exports neither createVM nor runCommand.`);
    }

    return output.join('').trimEnd() || '(no output)';
  };
}

export function registerRubyRunner() {
  const runner = createRubyRunner();
  registerVersionedRunner('ruby', runner, [...RUBY_VERSIONS], DEFAULT_RUBY_VERSION);
  setRunnerAvailability('ruby', {
    check: getAvailableRubyVersions,
    required: [...REQUIRED_RUBY_VERSIONS],
  });
}

registerRubyRunner();
