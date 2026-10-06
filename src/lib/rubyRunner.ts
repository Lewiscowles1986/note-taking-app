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
import { loadAsset, loadVendorManifest } from './wasmAssets';

export interface RubyBundle {
  version: string;
  directory: string;
}

/** Bundles vendored under public/ruby-wasm/, generated from each build manifest. */
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
  { version: '3.2.4', directory: '3.2' },
  { version: '3.3.3', directory: '3.3' },
  { version: '3.4.1', directory: '3.4' },
  { version: '4.0.0', directory: '4.0' },
];
export const RUBY_VERSIONS = RUBY_BUNDLES.map((b) => b.version);
export const DEFAULT_RUBY_VERSION = RUBY_VERSIONS[RUBY_VERSIONS.length - 1];
export const REQUIRED_RUBY_VERSIONS = [DEFAULT_RUBY_VERSION] as const;

export type RubyVersion = string;

function directoryFor(version: string): string {
  return RUBY_BUNDLES.find((b) => b.version === version)?.directory ?? version;
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
    const res = await fetch(`${base}ruby-wasm/build-${directoryFor(version)}/vendor.json`, { method: 'HEAD' });
    return res.ok;
  } catch {
    return true;
  }
}

export async function getAvailableRubyVersions(): Promise<string[]> {
  if (availabilityCache) return availabilityCache;
  const results = await Promise.all(
    RUBY_BUNDLES.map(async (b) => ({ v: b.version, ok: await checkRubyVersionAvailable(b.version) })),
  );
  availabilityCache = results.filter((r) => r.ok).map((r) => r.v);
  return availabilityCache;
}

export function createRubyRunner() {
  return async (code: string, options?: { version?: string }): Promise<string> => {
    const version = options?.version ?? DEFAULT_RUBY_VERSION;
    const base = import.meta.env.BASE_URL || '/';
    const dir = `${base}ruby-wasm/build-${directoryFor(version)}/`;

    const manifest = await loadVendorManifest(dir);
    const bytes = await loadAsset(dir, 'ruby.wasm', manifest);
    // Both integration families export their entry point from runtime.mjs (the
    // historical one is a dependency of the module, not the entry point). A
    // literal filename in the specifier keeps the dev server from appending its
    // `?import` query, which 500s for files under public/.
    const adapter = (await import(
      /* @vite-ignore */ `${base}ruby-wasm/build-${directoryFor(version)}/runtime.mjs`
    )) as RubyAdapter;

    const output: string[] = [];
    const send: RubyOutput = (stream, text) => {
      if (!text) return;
      output.push(stream === 'stderr' ? `[error] ${text}` : text);
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
