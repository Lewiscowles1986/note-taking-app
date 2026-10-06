/**
 * Sandboxed Elixir executor via WebAssembly (BEAM under Emscripten).
 *
 * The BEAM build is threaded and needs shared memory, so it runs in a Web
 * Worker (`elixir.worker.ts`) which requires a cross-origin isolated context;
 * see docs/wasm/elixir.md for the COOP/COEP requirement. One vendored bundle
 * per Elixir line under /elixir-wasm/build-<version>/.
 */

import { registerVersionedRunner, setRunnerAvailability } from './codeRunners';

export interface ElixirBundle {
  version: string;
  directory: string;
}

/** Bundles vendored under public/elixir-wasm/. The matrix grows as builds land. */
export const ELIXIR_BUNDLES: ElixirBundle[] = [
  { version: '1.20.4', directory: '1.20.4' },
];
export const ELIXIR_VERSIONS = ELIXIR_BUNDLES.map((b) => b.version);
export const DEFAULT_ELIXIR_VERSION = ELIXIR_VERSIONS[ELIXIR_VERSIONS.length - 1];
export const REQUIRED_ELIXIR_VERSIONS = [DEFAULT_ELIXIR_VERSION] as const;

export type ElixirVersion = string;

function directoryFor(version: string): string {
  return ELIXIR_BUNDLES.find((b) => b.version === version)?.directory ?? version;
}

let availabilityCache: string[] | null = null;

export async function checkElixirVersionAvailable(version: string): Promise<boolean> {
  const base = import.meta.env.BASE_URL || '/';
  try {
    const res = await fetch(`${base}elixir-wasm/build-${directoryFor(version)}/vendor.json`, {
      method: 'HEAD',
    });
    return res.ok;
  } catch {
    return true;
  }
}

export async function getAvailableElixirVersions(): Promise<string[]> {
  if (availabilityCache) return availabilityCache;
  const results = await Promise.all(
    ELIXIR_BUNDLES.map(async (b) => ({ v: b.version, ok: await checkElixirVersionAvailable(b.version) })),
  );
  availabilityCache = results.filter((r) => r.ok).map((r) => r.v);
  return availabilityCache;
}

export function createElixirRunner() {
  return (code: string, options?: { version?: string }): Promise<string> => {
    const version = options?.version ?? DEFAULT_ELIXIR_VERSION;
    // The BEAM transfers a WebAssembly.Memory to its pthread workers, which only
    // works in a cross-origin isolated context. Fail with something actionable
    // instead of the browser's "DataCloneError: The WebAssembly.Memory object
    // cannot be serialized" (see docs/wasm/elixir.md).
    if (typeof self !== 'undefined' && 'crossOriginIsolated' in self && !self.crossOriginIsolated) {
      return Promise.reject(
        new Error(
          'Elixir needs a cross-origin isolated context, and this host does not provide one. ' +
            'The server must send Cross-Origin-Opener-Policy: same-origin and ' +
            'Cross-Origin-Embedder-Policy: require-corp. GitHub Pages cannot send these headers, ' +
            'so Elixir blocks only run in local dev, the dev container, or a proxy you control.',
        ),
      );
    }
    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./elixir.worker.ts', import.meta.url), { type: 'module' });
      const output: string[] = [];
      worker.onmessage = (event: MessageEvent) => {
        const data = event.data as
          | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
          | { type: 'exit'; status: number; aborted: string | null }
          | { type: 'error'; message: string };
        if (data.type === 'output') {
          output.push(data.stream === 'stderr' ? `[error] ${data.text}` : data.text);
        } else if (data.type === 'error') {
          worker.terminate();
          reject(new Error(data.message));
        } else if (data.type === 'exit') {
          worker.terminate();
          const text = output.join('');
          if (data.aborted) reject(new Error(text || `Elixir aborted: ${data.aborted}`));
          else if (data.status !== 0) reject(new Error(text || `Elixir exited with status ${data.status}`));
          else resolve(text.trimEnd() || '(no output)');
        }
      };
      worker.onerror = (event: ErrorEvent) => {
        worker.terminate();
        reject(new Error(event.message || 'Elixir worker failed'));
      };
      worker.postMessage({
        base: import.meta.env.BASE_URL || '/',
        directory: directoryFor(version),
        code,
      });
    });
  };
}

export function registerElixirRunner() {
  const runner = createElixirRunner();
  registerVersionedRunner('elixir', runner, [...ELIXIR_VERSIONS], DEFAULT_ELIXIR_VERSION);
  setRunnerAvailability('elixir', {
    check: getAvailableElixirVersions,
    required: [...REQUIRED_ELIXIR_VERSIONS],
  });
}

registerElixirRunner();
