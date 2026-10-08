---
audience: engineer
diataxis: explanation
reading-time: ~4 min
staged-files:
  - package.json
  - src/lib/posthog.ts
  - src/lib/posthogSdk.ts
  - src/build-stubs/posthog.ts
  - vite.config.ts
  - src/main.tsx
last-reviewed: 2026-10-08
---

# Product analytics setup (staged changes)

This document describes the product analytics code staged for commit. Read it
to understand what exists, why it is shaped that way, and what happens in each
configuration case. For how to make changes, see the how-to documents listed
in the [index](../README.md).

## What was added

One dependency (`posthog-js`), a dependency-free shim
([src/lib/posthog.ts](../../../src/lib/posthog.ts)) that every component and
hook imports, and the SDK loader
([src/lib/posthogSdk.ts](../../../src/lib/posthogSdk.ts)) that dynamically
imports `posthog-js` only when a project key exists. `src/main.tsx` no longer
imports analytics: the SDK's bytes live in a lazy chunk fetched at first use,
not in the eager entry bundle the app boots from.

Calls are fire-and-forget ("sidecar"): raising an event never awaits network
activity, and a blocked or unreachable analytics host produces no user-visible
error and no change in app behaviour.

## Configuration sources

Two environment variables control the module. Vite only exposes variables
prefixed with `VITE_` to browser code, which is why the names start that way:

| Variable | Purpose |
|---|---|
| `VITE_POSTHOG_KEY` | The project token that identifies where events go |
| `VITE_POSTHOG_HOST` | Optional. The server that receives events; absence falls back to the EU region (`https://eu.i.posthog.com`) |

Both values are public by design: browser analytics keys ship inside the
JavaScript bundle and are visible to anyone who loads the app. The example
file [.env.example](../../../.env.example) documents them;
[.gitignore](../../../.gitignore) lists `.env` so real values stay uncommitted.
Package-lock and package.json changes add only the `posthog-js` dependency.

## The three build-time cases

[vite.config.ts](../../../vite.config.ts) reads the key via `loadEnv` at
config load, and takes exactly one of three paths:

1. **Key set —** analytics ships. The shim dynamically imports the SDK,
   which sits in its own lazy chunk (~330 KB raw / ~105 KB gzip at time of
   writing) fetched on first use; the entry bundle carries only the shim
   (~1 KB). Events raised before the SDK finishes loading replay from an
   in-memory queue; if the load fails or is blocked, queued items drop
   silently.
2. **Key absent —** two eliminations apply, so no analytics code ships at
   all:
   - `@/lib/posthog` is aliased to a no-op stub
     ([src/build-stubs/posthog.ts](../../../src/build-stubs/posthog.ts)).
   - The `drop-analytics-calls` plugin (in the same config) removes the call
     statements themselves — `posthogCapture(...)`, the log-helper bodies,
     and the identity calls in `oidcAuth.ts` — and prunes now-unused
     imports; what remains is tree-shaken away. A keyless bundle contains no
     event names, no shim, and no SDK (CI and no-sync builds take this
     path).
3. **Key set, host absent —** analytics ships and targets the EU region via
   the fallback in the loader; no stub, no error.

There is no runtime throw in any case, including development: a dev server
without a key simply runs with analytics off.

## What the SDK's init turns on

The single `posthog.init` call in the loader sets:

- `defaults: "2026-05-30"` — a dated preset that pins posthog-js
  behaviour to that release's defaults instead of tracking upstream defaults
  as they change.
- `logs` — a service name (`note-haven-web`) and the build mode
  (`import.meta.env.MODE`, e.g. `development` or `production`) attached to
  events the logger sends, so entries can be told apart by origin.
- `capture_exceptions` — unhandled errors and unhandled promise rejections
  are reported; console errors are not (they are often noise, and are
  typically already represented by the unhandled error).

## Where events are raised

Analytics calls live in three forms, all going through the shim's exports:

- `posthogCapture(...)` calls inside components and pages — one call per
  user action worth counting (see
  [how-to-add-analytics-event](how-to-add-analytics-event.md)).
- `posthogLogger...` calls in [src/lib/posthogLogs.ts](../../../src/lib/posthogLogs.ts)
  — structured log lines for sync rounds (see
  [how-to-add-log-event](how-to-add-log-event.md)).
- Identity handling in [src/lib/oidcAuth.ts](../../../src/lib/oidcAuth.ts) —
  sign-in and sign-out boundaries call identify/reset (see
  [how-to-manage-identification](how-to-manage-identification.md)).

The SDK persists an identity between page loads, so events after a sign-in
keep the signed-in attribution until sign-out removes it.