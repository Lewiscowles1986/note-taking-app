---
audience: engineer
diataxis: howto
reading-time: ~3 min
staged-files:
  - package.json
  - .env.example
  - src/lib/posthog.ts
last-reviewed: 2026-10-08
---

# How to reconfigure the analytics SDK

Use this when you need to change where events go, what the SDK enables at
startup, or the failure behaviour when configuration is missing. The setup
lives in one place: [src/lib/posthog.ts](../../../src/lib/posthog.ts).

## Before you start

- You can run the app (`npm run dev`).
- You know the new project token and/or host, if the change is about
  destinations.

## Change a destination (host or key)

1. Edit the value in your local `.env` (copy `.env.example` if you don't
   have one). Files affected: `.env` only — no code change.
2. Restart the dev server. Vite reads `.env` at start-up, not per request.
3. Confirm events arrive at the new host, e.g. via the browser network tab.

## Change what the SDK enables at startup

Edit the options object in the `posthog.init` call:

| You want to | Touch |
|---|---|
| Pin different SDK default behaviour | The `defaults` value (a dated string) |
| Change the service name or build-mode label on log events | `logs.serviceName` / `logs.environment` |
| Report console errors too | `capture_exceptions.capture_console_errors: true` |

Then:

1. Run the app and check the new behaviour in the browser network tab.
2. Run `npm run lint` and `npm run test` for the standard checks.

## Change the missing-config behaviour

The module currently throws in development and is inert in production when
variables are missing. To alter either path, edit the `if (!posthogKey ||
!posthogHost)` block:

1. Decide the behaviour per environment (`import.meta.env.DEV` separates the
   two cases).
2. Keep the production path silent: a missing variable must disable
   analytics, not break the app for visitors.
3. Re-test both cases: unset each variable in turn for a dev run, and check
   a production build (`npm run build`) still loads.

## Doing the same edit with the PostHog wizard

The staged change was produced with PostHog's AI integration wizard for web
(`.claude/skills/integration-javascript_web/`). To let it re-do or extend
setup instead of editing by hand:

1. Run the wizard and describe the configuration change.
2. Review its edits against `src/lib/posthog.ts` before staging: the wizard
   may rewrite options, add env variables, or change error handling.
3. Confirm `.env.example` still matches any new `VITE_` variables, and
   `.gitignore` still excludes `.env`.

## Checklist before you commit

- [ ] `.env.example` updated if you introduced or renamed a `VITE_` variable
- [ ] `.env` itself is not staged
- [ ] Both missing-variable paths still behave as intended
- [ ] This document's front-matter `staged-files` list still matches reality