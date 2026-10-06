/**
 * Registration entry point for the wasm-backed language runners.
 *
 * Every `*Runner.ts` module in this directory registers itself on import, and
 * `import.meta.glob` pulls them in eagerly. That keeps the runner modules in
 * the CodeBlock chunk (so their wasm payloads are only fetched when a code
 * block renders) while letting each language own its own file — adding a
 * language is a new file, not an edit here.
 *
 * The eager glob is required: a lazy glob returns import functions, which would
 * not run the modules' side effects.
 */

const modules = import.meta.glob('./*Runner.ts', { eager: true }) as Record<string, unknown>;

for (const [path, mod] of Object.entries(modules)) {
  if (path.endsWith('/codeRunners.ts')) continue;
  for (const value of Object.values(mod as Record<string, unknown>)) {
    if (typeof value === 'function' && /^register\w*Runner$/.test(value.name)) {
      (value as () => void)();
    }
  }
}
