import posthog from "posthog-js";

// Only reached when a VITE_POSTHOG_KEY exists at build time (vite.config.ts
// aliases "@/lib/posthog" to a no-op stub otherwise, so this module never
// loads and the posthog-js SDK never ships). Host falls back to the EU
// region when VITE_POSTHOG_HOST is unset.
const key = import.meta.env.VITE_POSTHOG_KEY as string;
const host = import.meta.env.VITE_POSTHOG_HOST || "https://eu.i.posthog.com";

let ready: Promise<typeof posthog> | undefined;

function start(): Promise<typeof posthog> {
  ready ??= Promise.resolve(
    posthog.init(key, {
      api_host: host,
      defaults: "2026-05-30",
      logs: {
        serviceName: "note-haven-web",
        environment: import.meta.env.MODE,
      },
      capture_exceptions: {
        capture_unhandled_errors: true,
        capture_unhandled_rejections: true,
        capture_console_errors: false,
      },
    }),
  ).then(() => posthog);
  return ready;
}

// Fire-and-forget initialisation: the SDK fetches its own chunk and must
// never block or reject into app code.
void start().catch(() => undefined);

export default posthog;