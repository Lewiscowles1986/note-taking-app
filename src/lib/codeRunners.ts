/**
 * Code block execution registry.
 *
 * Register language-specific runners that return a Promise<string>.
 * Resolve → output rendered below the block.
 * Reject  → error rendered below the block.
 *
 * Runners may be versioned (e.g. PHP wasm builds). When a runner declares
 * `versions`, the code block UI shows a version selector and passes the
 * selected version to the runner via `RunOptions.version`.
 */

export interface RunOptions {
  version?: string;
}

export type CodeRunner = (code: string, options?: RunOptions) => Promise<string>;

export interface RunnerDefinition {
  run: CodeRunner;
  versions?: string[];
  defaultVersion?: string;
}

/**
 * Optional per-language version probe. `check` returns the versions actually
 * present (e.g. by HEAD-requesting each build); `required` versions missing
 * from that list raise a warning in the UI.
 */
export interface RunnerAvailability {
  check: () => Promise<string[]>;
  required?: string[];
}

const runners = new Map<string, RunnerDefinition>();
const availability = new Map<string, RunnerAvailability>();

export function registerRunner(language: string, runner: CodeRunner) {
  runners.set(language.toLowerCase(), { run: runner });
}

export function registerVersionedRunner(
  language: string,
  runner: CodeRunner,
  versions: string[],
  defaultVersion?: string,
) {
  runners.set(language.toLowerCase(), {
    run: runner,
    versions,
    defaultVersion: defaultVersion ?? versions[0],
  });
}

export function unregisterRunner(language: string) {
  runners.delete(language.toLowerCase());
}

export function getRunner(language: string): CodeRunner | undefined {
  return runners.get(language.toLowerCase())?.run;
}

export function hasRunner(language: string): boolean {
  return runners.has(language.toLowerCase());
}

export function listRunners(): string[] {
  return Array.from(runners.keys());
}

export function getRunnerVersions(language: string): string[] | undefined {
  return runners.get(language.toLowerCase())?.versions;
}

export function getDefaultVersion(language: string): string | undefined {
  return runners.get(language.toLowerCase())?.defaultVersion;
}

export function setRunnerAvailability(language: string, entry: RunnerAvailability) {
  availability.set(language.toLowerCase(), entry);
}

export function getRunnerAvailability(language: string): RunnerAvailability | undefined {
  return availability.get(language.toLowerCase());
}
