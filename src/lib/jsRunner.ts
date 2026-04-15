/**
 * Sandboxed JavaScript executor.
 *
 * Runs JS code with console.log/warn/error captured as output.
 * Blocks dangerous globals: alert, confirm, prompt, open, fetch, XMLHttpRequest, eval (nested).
 */

import { registerRunner } from './codeRunners';

export function createSandboxedJSRunner() {
  return async (code: string, engine: string = 'default'): Promise<string> => {
    const output: string[] = [];

    const blockedFn = (name: string) => () => {
      output.push(`[blocked] ${name}() is not available in sandbox`);
    };

    const sandboxConsole = {
      log: (...args: unknown[]) => output.push(`[log]: ${args.map(formatValue).join(' ')}`),
      warn: (...args: unknown[]) => output.push(`[log] ⚠: ${args.map(formatValue).join(' ')}`),
      error: (...args: unknown[]) => output.push(`[log] ✗: ${args.map(formatValue).join(' ')}`),
      info: (...args: unknown[]) => output.push(`[log] ℹ: ${args.map(formatValue).join(' ')}`),
    };

    const blocked = {
      alert: blockedFn('alert'),
      confirm: blockedFn('confirm'),
      prompt: blockedFn('prompt'),
      open: blockedFn('window.open'),
      window: { open: blockedFn('window.open') },
      fetch: blockedFn('fetch'),
      XMLHttpRequest: blockedFn('XMLHttpRequest'),
      eval: blockedFn('eval'),
      Function: blockedFn('Function'),
      setInterval: blockedFn('setInterval'),
    };

    const safeTimeout = (fn: () => void, ms: number) => {
      if (ms > 5000) {
        output.push('[blocked] setTimeout with delay > 5s');
        return 0;
      }
      return window.setTimeout(fn, ms);
    };

    // Build the wrapper that shadows dangerous globals
    const blockedNames = Object.keys(blocked);
    const destructure = blockedNames.join(', ');
    const wrappedCode = [
      `return (async (__console, __blocked, __setTimeout, Math, Date, JSON, parseInt, parseFloat, isNaN, isFinite, Number, String, Boolean, Array, Object, Map, Set, RegExp, Error, Promise, Symbol) => {`,
      `  const console = __console;`,
      `  const setTimeout = __setTimeout;`,
      `  const { ${destructure} } = __blocked;`,
      code,
      `})(...arguments)`,
    ].join('\n');

    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new (window.Function as typeof Function)(wrappedCode);
      const result = await fn(
        sandboxConsole, blocked, safeTimeout,
        Math, Date, JSON, parseInt, parseFloat, isNaN, isFinite,
        Number, String, Boolean, Array, Object, Map, Set, RegExp, Error, Promise, Symbol,
      );
      if (result !== undefined) {
        output.push(formatValue(result));
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }


    return output.join('\n');
  };
}

function formatValue(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

// Auto-register JS and JavaScript runners
export function registerJSRunner() {
  const runner = createSandboxedJSRunner();
  registerRunner('javascript', runner);
  registerRunner('js', runner);
}
