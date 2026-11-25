/**
 * Sandboxed PHP executor via WebAssembly.
 *
 * Loads a PHP build (php-web.mjs + php-web.wasm) from /php-wasm/build-<series>.x/
 * and runs code through the exported `phpw_run` C function. Output written to
 * stdout/stderr is captured through the emscripten `print`/`printErr` callbacks.
 *
 * The bundle list is compiled in from phpWasm.manifest.json, which
 * scripts/sync-php-wasm.mjs regenerates from the builder's output. Nothing is
 * probed at runtime: the manifest is the list, so the selector cannot offer a
 * build the deploy left out, and no HEAD request per version is needed.
 *
 * The module is cached per version so switching versions only reloads when the
 * selected version changes.
 */

import manifest from './phpWasm.manifest.json';
import { registerVersionedRunner } from './codeRunners';
import { isLanguageEnabled } from './languages';
import { loadAsset, loadVendorManifest } from './wasmAssets';

export interface PhpBundle {
  version: string;
  /** `build-<series>.x` directory under public/php-wasm/. */
  directory: string;
  /** `legacy` for bundles the current builder does not produce (PHP 5.x/7.x). */
  source: string;
}

/** Bundles vendored under public/php-wasm/, oldest first. */
export const PHP_BUNDLES: PhpBundle[] = manifest.bundles;

export const PHP_VERSIONS: string[] = PHP_BUNDLES.map((b) => b.version);

/** The newest bundle unless scripts/sync-php-wasm.mjs was told otherwise. */
export const DEFAULT_PHP_VERSION: string = manifest.default;

export type PhpVersion = string;

function directoryFor(version: string): string {
  return PHP_BUNDLES.find((b) => b.version === version)?.directory ?? `build-${version}.x`;
}

interface PhpModule {
  ccall: (
    name: string,
    returnType: string | null,
    argTypes: string[],
    args: unknown[],
  ) => unknown;
}

let loadedModule: PhpModule | null = null;
let loadedVersion: string | null = null;
let outputBuffer: string[] = [];

async function loadPhp(version: string): Promise<PhpModule> {
  if (loadedModule && loadedVersion === version) {
    return loadedModule;
  }

  // Resolve against the app's base URL (e.g. "/" in dev, "/note-taking-app/"
  // on GitHub Pages) so the wasm is loaded from THIS repo, not the domain root.
  const base = import.meta.env.BASE_URL || '/';
  const dir = `${base}php-wasm/${directoryFor(version)}/`;
  // Load the wasm ourselves: it is vendored gzipped, and the Emscripten runtime
  // would otherwise fetch the uncompressed name (see scripts/vendor-wasm.mjs).
  const vendor = await loadVendorManifest(dir);
  const wasmBinary = await loadAsset(dir, 'php-web.wasm', vendor);
  // A literal filename in the specifier keeps the dev server from appending its
  // `?import` query, which 500s for files under public/.
  const mod = await import(/* @vite-ignore */ `${dir}php-web.mjs`);
  const createPhpModule = mod.default as (
    opts: Record<string, unknown>,
  ) => Promise<PhpModule>;

  const php = await createPhpModule({
    wasmBinary,
    // Some PHP builds (8.x) ignore wasmBinary and fetch the wasm by name, which
    // is not present uncompressed. Instantiate from the bytes we already
    // decompressed, so every version loads the same way.
    instantiateWasm: (
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      WebAssembly.instantiate(wasmBinary, imports)
        .then(({ instance, module }) => successCallback(instance, module))
        .catch(() => {
          // Fall back to the module's own loader if this build rejects it.
        });
      return {};
    },
    print(data: string) {
      if (!data) return;
      if (outputBuffer.length) outputBuffer.push('\n');
      outputBuffer.push(data);
    },
    printErr(data: string) {
      if (!data) return;
      if (outputBuffer.length) outputBuffer.push('\n');
      outputBuffer.push(`[error] ${data}`);
    },
  });

  loadedModule = php;
  loadedVersion = version;
  return php;
}

export function createPhpRunner() {
  return async (
    code: string,
    options?: { version?: string },
  ): Promise<string> => {
    const version = options?.version ?? DEFAULT_PHP_VERSION;
    const php = await loadPhp(version);
    outputBuffer = [];
    try {
      php.ccall('phpw_run', null, ['string'], [normalizePhpCode(code)]);
    } catch (err) {
      // Wasm runtime traps (e.g. "function signature mismatch" from an indirect
      // call, or "null function" for a function not compiled into the build)
      // surface as opaque JS errors. Translate them into something actionable.
      const msg = err instanceof Error ? err.message : String(err);
      if (/signature mismatch|null function/i.test(msg)) {
        throw new Error(
          `This PHP ${version} wasm build hit a runtime error (${msg}). ` +
            'The build may not support this function — try a newer PHP version.',
        );
      }
      throw err;
    }
    const output = outputBuffer.join('');
    // Fatal/parse errors are written to stdout by the embedded SAPI; surface
    // them as a thrown error so the code block renders them as error output
    // rather than a green "success" result.
    if (/^(Fatal error|Parse error):/.test(output)) {
      throw new Error(output);
    }
    return output || '(no output)';
  };
}

/**
 * `phpw_run` evaluates code through `zend_eval_string`, which implicitly wraps
 * the string in `<?php ... ?>`. Plain statements (e.g. `echo "hi";`) therefore
 * run as-is, but code that already opens a `<?php`/`<?` tag would nest and
 * cause a parse error — so we close the implicit tag first (the same trick the
 * php.net interactive examples use).
 */
function normalizePhpCode(code: string): string {
  const trimmed = code.trimStart();
  if (trimmed.startsWith('<?')) {
    return '?>' + code;
  }
  return code;
}

export function registerPhpRunner() {
  const runner = createPhpRunner();
  registerVersionedRunner('php', runner, [...PHP_VERSIONS], DEFAULT_PHP_VERSION);
}

if (isLanguageEnabled('php')) registerPhpRunner();
