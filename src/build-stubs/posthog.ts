/**
 * Build-time stub for the product analytics shim — compiled in ONLY when the
 * build has no VITE_POSTHOG_KEY (vite.config.ts aliases "@/lib/posthog"
 * here). Every export mirrors src/lib/posthog.ts's name and shape so
 * consumers typecheck unchanged; the bodies are no-ops and import nothing,
 * so the posthog-js SDK never ships in such builds.
 */

interface Logger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

function capture(_eventName: string, _properties?: Record<string, unknown>): void {}

function identify(_distinctId: string, _properties?: Record<string, unknown>): void {}

function reset(): void {}

function has_identity(): boolean {
  return false;
}

const logger: Logger = {
  info() {},
  warn() {},
  error() {},
};

export { capture, identify, reset, has_identity, logger };
export default { capture, identify, reset, has_identity, logger };