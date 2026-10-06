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

import { registerVersionedRunner, setRunnerAvailability, setRunnerWarm } from './codeRunners';
import { loadAsset, loadVendorManifest, loadWasmIndex, type WasmIndex } from './wasmAssets';
import { isLanguageEnabled } from './languages';

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
  { version: '1.2.6', directory: '1.2.6' },
  { version: '1.3.7', directory: '1.3.7' },
  { version: '1.4.6', directory: '1.4.6' },
  { version: '1.5.0', directory: '1.5.0' },
  { version: '1.6.8', directory: '1.6.8' },
  { version: '1.7.1', directory: '1.7.1' },
  { version: '1.8.7', directory: '1.8.7-p374' },
  { version: '2.2.10', directory: '2.2.10' },
  { version: '2.3.8', directory: '2.3.8' },
  { version: '2.4.10', directory: '2.4.10' },
  { version: '2.5.9', directory: '2.5.9' },
  { version: '2.6.10', directory: '2.6.10' },
  { version: '2.7.8', directory: '2.7.8' },
  { version: '3.0.7', directory: '3.0.7' },
  { version: '3.1.7', directory: '3.1.7' },
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

/**
 * Emscripten cannot create a native timer thread, so the yarv builds 2.2-2.5
 * write a timer-thread message to stderr on every run (2.2 says "[FATAL] Failed
 * to create timer thread", 2.3-2.5 say "pthread_create failed for timer").
 * Ruby carries on either way and the exit status still reports a real failure,
 * so this one line is dropped rather than shown as an error.
 */
const TIMER_NOISE = /^(?:\[FATAL\] )?(?:<main>: warning: )?(?:pthread_create failed for timer|Failed to create timer thread)/;

export function stripRubyTimerNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => line && !TIMER_NOISE.test(line.trim()))
    .join('\n');
}

interface RubyVM {
  eval(code: string): { toString(): string };
}

interface RubyAdapter {
  createVM?: (bytes: Uint8Array, output: RubyOutput, stdin?: string) => Promise<{ vm: RubyVM; flush(): void }>;
  runCommand?: (bytes: Uint8Array, output: RubyOutput, source: string, stdin?: string) => Promise<unknown>;
}

/**
 * Fetch a language's runtime assets without running anything, so the service
 * worker's runtime cache has them before the first Run. Called when a block for
 * the language appears, which is the earliest sign the reader wants it.
 *
 * The requested (or default) version is fetched first so it is ready fastest,
 * then every other vendored version is attempted with a little concurrency. Each
 * failure is ignored: this is a prefetch, and the normal Run path reports real
 * errors.
 */
async function warmVersion(version: string): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  const dir = `${base}ruby-wasm/build-${await directoryFor(version)}/`;
  try {
    const manifest = await loadVendorManifest(dir);
    await Promise.all([
      loadAsset(dir, 'ruby.wasm', manifest),
      fetch(`${dir}${manifest.loader}`),
    ]);
  } catch {
    // Offline, or this bundle is absent: skip it and keep warming the rest.
  }
}

async function allRubyBundles(): Promise<RubyBundle[]> {
  try {
    const index = await loadWasmIndex('ruby');
    if (index.bundles.length > 0) return index.bundles;
  } catch {
    // Fall back to the bundled list.
  }
  return RUBY_BUNDLES;
}

export async function warmRubyRuntime(version: string = DEFAULT_RUBY_VERSION): Promise<void> {
  const bundles = await allRubyBundles();
  const rest = bundles.map((b) => b.version).filter((v) => v !== version);
  await warmVersion(version);
  const limit = 3;
  for (let i = 0; i < rest.length; i += limit) {
    await Promise.all(rest.slice(i, i + limit).map(warmVersion));
  }
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
      if (stream === 'stderr') {
        const kept = stripRubyTimerNoise(text);
        if (!kept) return;
        output.push(`[stderr] ${kept}`);
        return;
      }
      output.push(text);
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
  setRunnerWarm('ruby', warmRubyRuntime);
}

if (isLanguageEnabled('ruby')) registerRubyRunner();
