/**
 * Product analytics shim — the only import path app code uses.
 *
 * The real SDK lives behind a dynamic `import()` in posthogSdk.ts, so its
 * bytes sit in a lazy chunk that loads on first use instead of the eager
 * entry bundle. When the build has no VITE_POSTHOG_KEY, vite.config.ts
 * aliases this module to src/build-stubs/posthog.ts and the SDK never ships.
 *
 * Every operation is fire-and-forget ("sidecar"): app logic never awaits
 * PostHog, and a blocked or failing host is swallowed without user-visible
 * errors. Events raised before the SDK finishes loading replay from the
 * queue in order, so identity changes apply after the captures they follow.
 */

type PosthogModule = typeof import("./posthogSdk")["default"];
type LogAttributes = import("posthog-js").LogAttributes;

interface Logger {
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, attributes?: LogAttributes): void;
}

const key = import.meta.env.VITE_POSTHOG_KEY ?? undefined;

let loadPromise: Promise<PosthogModule | null> | undefined;

function loadSdk(): Promise<PosthogModule | null> {
  if (!key) return Promise.resolve(null);
  loadPromise ??= import("./posthogSdk")
    .then((m) => m.default)
    .catch(() => null);
  return loadPromise;
}

let queue: ((posthog: PosthogModule) => void)[] = [];
let pendingIdentity: string | null = null;

function enqueue(operation: (posthog: PosthogModule) => void): void {
  queue.push(operation);
  loadSdk().then(
    (posthog) => {
      if (!posthog) {
        // Analytics unavailable (blocked, failing, or never configured):
        // drop silently and clear state so nothing replays a stale identity.
        queue = [];
        pendingIdentity = null;
        return;
      }
      queue = queue.filter((op) => {
        try {
          op(posthog);
          return false;
        } catch {
          return true; // keep for a later retry tick
        }
      });
    },
    () => undefined,
  );
}

function capture(eventName: string, properties?: Record<string, unknown>): void {
  enqueue((posthog) => posthog.capture(eventName, properties));
}

/**
 * Attach an identity to all queued and future events. Enqueued after any
 * earlier captures, so the SDK applies captures with the identity they were
 * raised under, then switches. Switching accounts resets first, so one
 * account's events are never stitched onto another's.
 */
function identify(distinctId: string, properties?: Record<string, unknown>): void {
  pendingIdentity = distinctId;
  enqueue((posthog) => {
    const current = posthog.get_property("$user_id");
    if (typeof current === "string" && current && current !== distinctId) posthog.reset();
    posthog.identify(distinctId, properties);
  });
}

/**
 * Drop the identity this shim set (sign-out). The caller (oidcAuth) compares
 * the server's expected distinct id against the SDK's before resetting, so
 * a reset here only follows a match with the identity this shim itself set.
 */
function reset(): void {
  if (!pendingIdentity) return;
  pendingIdentity = null;
  enqueue((posthog) => posthog.reset());
}

/** True when this client has an identity queued or applied, else false. */
function has_identity(): boolean {
  return pendingIdentity !== null;
}

const logger: Logger = {
  info(message, attributes) {
    enqueue((posthog) => posthog.logger.info(message, attributes));
  },
  warn(message, attributes) {
    enqueue((posthog) => posthog.logger.warn(message, attributes));
  },
  error(message, attributes) {
    enqueue((posthog) => posthog.logger.error(message, attributes));
  },
};

export { capture, identify, reset, has_identity, logger };
export default { capture, identify, reset, has_identity, logger };
