---
audience: engineer
diataxis: howto
reading-time: ~3 min
staged-files:
  - package.json
  - .env.example
  - vite.config.ts
  - src/lib/posthog.ts
  - src/lib/posthogSdk.ts
last-reviewed: 2026-10-08
---

# How to reconfigure the analytics SDK

Use this when you need to change where events go, what the SDK enables at
startup, or whether analytics ships in a build at all. Calls go through a
dependency-free shim ([src/lib/posthog.ts](../../../src/lib/posthog.ts));
the SDK itself loads from [src/lib/posthogSdk.ts](../../../src/lib/posthogSdk.ts)
only when a key exists.

## Before you start

- You can run the app (`npm run dev`).
- You know the new project token and/or host, if the change is about
  destinations.

## Change a destination (host or key)

1. Edit the value in your local `.env` (copy `.env.example` if you don't
   have one). Files affected: `.env` only — no code change.
2. Restart the dev server. Vite reads `.env` at start-up, not per request.
   An unset `VITE_POSTHOG_HOST` is valid: the SDK targets the EU region
   (`https://eu.i.posthog.com`).
3. Confirm events arrive at the new host, e.g. via the browser network tab.

## Include or exclude analytics from a build

Inclusion is decided at build time by whether `VITE_POSTHOG_KEY` is set:

- Key set: the SDK ships in a lazy chunk loaded at first event.
- Key absent:
  [vite.config.ts](../../../vite.config.ts) aliases `@/lib/posthog` to
  [src/build-stubs/posthog.ts](../../../src/build-stubs/posthog.ts) AND its
  `drop-analytics-calls` plugin removes the call statements from every
  consumer file (they compile away with the now-unused imports and
  helpers). Nothing to do at call sites — you can leave
  `posthogCapture(...)` calls in code permanently.

Nothing else needs changing to flip a build between the two states. The
plugin matches a fixed list of call shapes (see its `ANALYTICS_CALLEES` in
the config); a differently named analytics function in a keyless build is
NOT removed — when introducing one, add it to that list.

## Change what the SDK enables at startup

Edit the options object in the `posthog.init` call in
[posthogSdk.ts](../../../src/lib/posthogSdk.ts):

| You want to | Touch |
|---|---|
| Pin different SDK default behaviour | The `defaults` value (a dated string) |
| Change the service name or build-mode label on log events | `logs.serviceName` / `logs.environment` |
| Report console errors too | `capture_exceptions.capture_console_errors: true` |

Then:

1. Run the app and check the new behaviour in the browser network tab.
2. Run `npm run lint` and `npm run test` for the standard checks.

## Doing the same edit with the PostHog wizard

The staged change was produced with PostHog's AI integration wizard for web
(`.claude/skills/integration-javascript_web/`). To let it re-do or extend
setup instead of editing by hand:

1. Run the wizard and describe the configuration change.
2. Review its edits before staging: the wizard may rewrite the init options,
   add env variables, or reintroduce an import-time `posthog.init` that puts
   the SDK back in the eager bundle. Keep the dynamic import and the shim.
3. Confirm `.env.example` still matches any new `VITE_` variables, and
   `.gitignore` still excludes `.env`.

## Checklist before you commit

- [ ] `.env.example` updated if you introduced or renamed a `VITE_` variable
- [ ] `.env` itself is not staged
- [ ] A build without a key still emits no analytics bytes
      (`git grep -c posthog dist/assets` shows only module names, or nothing)
- [ ] `npm run lint` and `npm run test` pass both with and without `.env`