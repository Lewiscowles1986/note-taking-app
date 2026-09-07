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
  '5.5.38',
  '5.6.40',
  '7.0.33',
  '7.1.33',
  '7.2.34',
  '7.3.33',
  '7.4.33',
  '8.0.30',
  '8.1.33',
  '8.2.29',
  '8.3.23',
  '8.4.x',
  '8.5.x',
] as const;
export const DEFAULT_PHP_VERSION = '8.4.x';

export type PhpVersion = (typeof PHP_VERSIONS)[number];

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
    php.ccall('phpw_run', null, ['string'], [normalizePhpCode(code)]);
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
