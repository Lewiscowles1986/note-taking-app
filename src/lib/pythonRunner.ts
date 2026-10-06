/**
 * Sandboxed CPython executor via WebAssembly.
 *
 * One vendored bundle per Python line under /python-wasm/build-<version>/, each
 * with a vendor.json describing its loader module and gzipped assets. Code runs
 * through the exported `callMain`, capturing stdout/stderr via the Emscripten
 * print callbacks.
 *
 * The Emscripten module cannot be re-entered after it exits, so each run gets a
 * fresh instance; only the availability probe is cached.
 */

import { registerVersionedRunner, setRunnerAvailability } from './codeRunners';
import { loadAsset, loadVendorManifest } from './wasmAssets';
import { isLanguageEnabled } from './languages';

export interface PythonBundle {
  version: string;
  directory: string;
}

/** Bundles vendored under public/python-wasm/, generated from the build matrix. */
export const PYTHON_BUNDLES: PythonBundle[] = [
  { version: '2.7.18', directory: '2.7.18' },
  { version: '3.0.1', directory: '3.0.1' },
  { version: '3.1.5', directory: '3.1.5' },
  { version: '3.2.6', directory: '3.2.6' },
  { version: '3.3.7', directory: '3.3.7' },
  { version: '3.4.10', directory: '3.4.10' },
  { version: '3.5.10', directory: '3.5.10' },
  { version: '3.6.15', directory: '3.6.15' },
  { version: '3.7.17', directory: '3.7.17' },
  { version: '3.8.20', directory: '3.8.20' },
  { version: '3.9.25', directory: '3.9.25' },
  { version: '3.10.21', directory: '3.10.21' },
  { version: '3.11.16', directory: '3.11.16' },
  { version: '3.12.14', directory: '3.12.14' },
  { version: '3.13.15', directory: '3.13.15' },
  { version: '3.14.7', directory: '3.14.7' },
  { version: '3.15.0rc2', directory: '3.15.0rc2' },
];
export const PYTHON_VERSIONS = PYTHON_BUNDLES.map((b) => b.version);
export const DEFAULT_PYTHON_VERSION = '3.14.7';
export const REQUIRED_PYTHON_VERSIONS = [DEFAULT_PYTHON_VERSION] as const;

export type PythonVersion = string;

function directoryFor(version: string): string {
  return PYTHON_BUNDLES.find((b) => b.version === version)?.directory ?? version;
}

interface PythonModule {
  callMain: (args: string[]) => number;
}

type PythonFactory = (options: Record<string, unknown>) => Promise<PythonModule>;

let availabilityCache: string[] | null = null;

export async function checkPythonVersionAvailable(version: string): Promise<boolean> {
  const base = import.meta.env.BASE_URL || '/';
  try {
    const res = await fetch(`${base}python-wasm/build-${directoryFor(version)}/vendor.json`, {
      method: 'HEAD',
    });
    return res.ok;
  } catch {
    return true;
  }
}

export async function getAvailablePythonVersions(): Promise<string[]> {
  if (availabilityCache) return availabilityCache;
  const results = await Promise.all(
    PYTHON_BUNDLES.map(async (b) => ({ v: b.version, ok: await checkPythonVersionAvailable(b.version) })),
  );
  availabilityCache = results.filter((r) => r.ok).map((r) => r.v);
  return availabilityCache;
}

export function createPythonRunner() {
  return async (code: string, options?: { version?: string }): Promise<string> => {
    const version = options?.version ?? DEFAULT_PYTHON_VERSION;
    const base = import.meta.env.BASE_URL || '/';
    const dir = `${base}python-wasm/build-${directoryFor(version)}/`;

    const manifest = await loadVendorManifest(dir);
    const [wasm, data] = await Promise.all([
      loadAsset(dir, 'python.wasm', manifest),
      loadAsset(dir, 'python.data', manifest),
    ]);

    // A literal filename in the specifier keeps the dev server from appending a
    // query string, which 500s for files under public/.
    const imported = (await import(
      /* @vite-ignore */ `${base}python-wasm/build-${directoryFor(version)}/python.mjs`
    )) as { default: PythonFactory };
    const factory = imported.default;
    if (typeof factory !== 'function') {
      throw new Error(`Python ${version} did not export an Emscripten module factory.`);
    }

    const output: string[] = [];
    let exitStatus = 0;
    const python = await factory({
      noInitialRun: true,
      wasmBinary: wasm,
      getPreloadedPackage: () => data.buffer,
      locateFile: (file: string) => `${dir}${file}`,
      print: (value: string) => { if (value) output.push(String(value)); },
      printErr: (value: string) => { if (value) output.push(`[error] ${String(value)}`); },
      onExit: (status: number) => { exitStatus = status; },
      quit: (status: number, error: unknown) => { exitStatus = status; throw error; },
      onAbort: (reason: unknown) => { throw new Error(`Python aborted: ${String(reason)}`); },
    });

    try {
      const result = python.callMain(['-c', code]);
      if (typeof result === 'number') exitStatus = result;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if ((err as { name?: string })?.name === 'ExitStatus' && typeof status === 'number') {
        exitStatus = status;
      } else {
        throw err;
      }
    }

    const text = output.join('\n');
    if (exitStatus !== 0) {
      throw new Error(text || `Python exited with status ${exitStatus}`);
    }
    return text.trimEnd() || '(no output)';
  };
}

export function registerPythonRunner() {
  const runner = createPythonRunner();
  registerVersionedRunner('python', runner, [...PYTHON_VERSIONS], DEFAULT_PYTHON_VERSION);
  setRunnerAvailability('python', {
    check: getAvailablePythonVersions,
    required: [...REQUIRED_PYTHON_VERSIONS],
  });
}

if (isLanguageEnabled('python')) registerPythonRunner();
