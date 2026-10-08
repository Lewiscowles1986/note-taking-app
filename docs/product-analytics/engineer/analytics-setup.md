---
audience: engineer
diataxis: explanation
reading-time: ~4 min
staged-files:
  - package.json
  - src/lib/posthog.ts
  - src/main.tsx
last-reviewed: 2026-10-08
---

# Product analytics setup (staged changes)

This document describes the product analytics code staged for commit. Read it
to understand what exists, why it is shaped that way, and what happens in each
configuration case. For how to make changes, see the how-to documents listed
in the [index](../README.md).

## What was added

One dependency (`posthog-js`) and one module, [src/lib/posthog.ts](../../../src/lib/posthog.ts),
imported from [src/main.tsx](../../../src/main.tsx) so it runs once at startup,
before the app renders.

## Configuration sources

Two environment variables control the module. Vite only exposes variables
prefixed with `VITE_` to browser code, which is why the names start that way:

| Variable | Purpose |
|---|---|
| `VITE_POSTHOG_KEY` | The project token that identifies where events go |
| `VITE_POSTHOG_HOST` | The server that receives events (for example `https://eu.i.posthog.com`) |

Both values are public by design: browser analytics keys ship inside the
JavaScript bundle and are visible to anyone who loads the app. The example
file [.env.example](../../../.env.example) documents them;
[.gitignore](../../../.gitignore) lists `.env` so real values stay uncommitted.
Package-lock and package.json changes add only the `posthog-js` dependency.

## The three start-up cases

On load, the module takes exactly one of three paths:

1. **Both variables set —** analytics starts. Events and errors go to the
   host from `VITE_POSTHOG_HOST`.
2. **A variable missing during development —** the module throws. The error
   names the missing variable and disappears once the value is set. This
   converts a silent failure (events quietly not sent) into a loud one.
3. **A variable missing in a production build —** the module does nothing.
   The app runs with analytics off rather than throwing for every visitor.

## What the init call turns on

The single `posthog.init` call in the staged module sets:

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

Analytics calls live in three forms:

- `posthog.capture(...)` calls inside components and pages — one call per
  user action worth counting (see
  [how-to-add-analytics-event](how-to-add-analytics-event.md)).
- `posthog.logger...` calls in [src/lib/posthogLogs.ts](../../../src/lib/posthogLogs.ts)
  — structured log lines for sync rounds (see
  [how-to-add-log-event](how-to-add-log-event.md)).
- Identity handling in [src/lib/oidcAuth.ts](../../../src/lib/oidcAuth.ts) —
  sign-in and sign-out boundaries call identify/reset (see
  [how-to-manage-identification](how-to-manage-identification.md)).

The SDK persists an identity between page loads, so events after a sign-in
keep the signed-in attribution until sign-out.