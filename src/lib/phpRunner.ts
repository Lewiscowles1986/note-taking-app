/**
 * Sandboxed PHP executor via WebAssembly.
 *
 * Loads a PHP build (php-web.mjs + php-web.wasm) from /php-wasm/build-<version>/
 * and runs code through the exported `phpw_run` C function. Output written to
 * stdout/stderr is captured through the emscripten `print`/`printErr` callbacks.
 *
 * The module is cached per version so switching versions only reloads when the
 * selected version changes.
 */

import { registerVersionedRunner } from './codeRunners';

export const PHP_VERSIONS = [
  '5.4.45',
  '7.4.33',
  '8.0.30',
  '8.1.34',
  '8.2.33',
  '8.3.33',
  '8.4.25',
  '8.5.10',
] as const;
export const DEFAULT_PHP_VERSION = '8.4.25';

/**
 * The "last" version of each major line (5.4, 7.4, 8.4). These are the ones we
 * expect to always be present; if any of them 404s we surface an alert. Other
 * versions are optional — if they're missing they're just skipped.
 */
export const REQUIRED_PHP_VERSIONS = ['5.4.45', '7.4.33', '8.4.25'] as const;

export type PhpVersion = (typeof PHP_VERSIONS)[number];

let availabilityCache: string[] | null = null;

/**
 * HEAD-request the version's php-web.mjs glue to see whether that build is
 * actually present (e.g. served by the app or the service worker cache).
 * Only an explicit 404 (or other non-OK status) marks a version as missing;
 * a network error or aborted request can't confirm a 404, so we optimistically
 * treat the build as present rather than dropping it from the selector.
 */
export async function checkPhpVersionAvailable(version: string): Promise<boolean> {
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}php-wasm/build-${version}/php-web.mjs`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return true;
  }
}

/**
 * Returns the subset of PHP_VERSIONS that are actually available, checking each
 * once and caching the result for the session.
 */
export async function getAvailablePhpVersions(): Promise<string[]> {
  if (availabilityCache) return availabilityCache;
  const results = await Promise.all(
    PHP_VERSIONS.map(async (v) => ({ v, ok: await checkPhpVersionAvailable(v) })),
  );
  availabilityCache = results.filter((r) => r.ok).map((r) => r.v);
  return availabilityCache;
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
  const mod = await import(/* @vite-ignore */ `${base}php-wasm/build-${version}/php-web.mjs`);
  const createPhpModule = mod.default as (
    opts: Record<string, unknown>,
  ) => Promise<PhpModule>;

  const php = await createPhpModule({
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
