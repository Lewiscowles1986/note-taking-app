/**
 * Code block execution registry.
 *
 * Register language-specific runners that return a Promise<string>.
 * Resolve → output rendered below the block.
 * Reject  → error rendered below the block.
 */

export type CodeRunner = (code: string) => Promise<string>;

const runners = new Map<string, CodeRunner>();

export function registerRunner(language: string, runner: CodeRunner) {
  runners.set(language.toLowerCase(), runner);
}

export function unregisterRunner(language: string) {
  runners.delete(language.toLowerCase());
}

export function getRunner(language: string): CodeRunner | undefined {
  return runners.get(language.toLowerCase());
}

export function hasRunner(language: string): boolean {
  return runners.has(language.toLowerCase());
}

export function listRunners(): string[] {
  return Array.from(runners.keys());
}
