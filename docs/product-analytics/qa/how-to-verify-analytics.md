---
audience: QA
diataxis: howto
reading-time: ~5 min
staged-files:
  - .env.example
  - src/lib/posthog.ts
  - src/lib/posthogLogs.ts
  - src/lib/oidcAuth.ts
  - src/pages/Index.tsx
  - src/pages/ServersPage.tsx
  - src/pages/SettingsPage.tsx
  - src/components/NoteEditor.tsx
  - src/components/NoteSidebar.tsx
  - src/hooks/useNotes.ts
last-reviewed: 2026-10-08
---

# How to verify analytics are sent

Use this to check that the analytics change behaves as documented: events,
log lines, error reports, identity handling, and the case where analytics is
switched off. No analytics account or special test project is required — a
local network observer is the receiver.

The source of truth for what should be sent is
[what the app records](../privacy/what-is-recorded.md) (privacy audience,
same content as this page references).

## Set up a receiver (~2 min)

1. In a terminal, start a local collector that answers any request and prints
   its path:

   ```sh
   npx http-echo-server 8787
   ```

   (any tool that logs request paths and returns 200 works; `http-echo-server`
   is one such package)
2. Copy [.env.example](../../../.env.example) to `.env` and point analytics
   at your collector:

   ```
   VITE_POSTHOG_KEY=<any non-empty string>
   VITE_POSTHOG_HOST=http://localhost:8787
   ```
3. Start the app with that env file: `npm run dev`. Vite reads `.env` at
   startup, so restart it if you edit `.env` during a session.

Every analytics message now arrives at your terminal with the full request
path, and the app itself keeps working (the collector doesn't speak the
analytics API — that is fine for observation).

Alternative: leave the real host configured and watch the browser DevTools
**Network** tab filtered to the analytics host. This also shows the request
bodies (JSON payloads) without any terminal.

> The SDK queues requests (`/batch`, `/e/`) rather than sending one per
> event. Expect bursts after actions, not one request per click.

## Test matrix

Each row: perform the action in the app, then confirm the collector output
(or network tab) shows the event name and the listed properties.

| # | Do this in the app | Expect |
|---|---|---|
| 1 | Create a note | `note_created`, no properties |
| 2 | Delete a note | `note_deleted`, no properties |
| 3 | Encrypt a note (choose a method) | `note_encrypted`, `encryption_method` = chosen method |
| 4 | Decrypt it | `note_decrypted` |
| 5 | Attach an image, then a file | two `attachment_added`, `attachment_type` = `image` then `file` |
| 6 | Export a note as HTML and as PDF | `notes_exported`, `export_format` = `html` / `pdf`, `note_count` = 1 |
| 7 | Export all as ZIP | `notes_exported`, `export_format` = `zip`, `note_count` = total notes |
| 8 | Back up database | `notes_exported`, `export_format` = `database_backup` |
| 9 | Import notes | `notes_imported`, `note_count` = imported count |
| 10 | Add a sync server | `sync_server_added` |
| 11 | Remove it | `sync_server_removed` |
| 12 | Run sync with a server configured | `sync_completed` with `sync_outcome`, `pushed_count`, `pulled_count`, `deleted_local_count`, `deleted_remote_count`, `error_count`; plus a log line `sync.round.completed` with the same counts |
| 13 | Make a sync fail outright (unreachable server URL) | log line `sync.round.failed`; no `sync_completed` event (the throw path) |
| 14 | Sync that ends with conflicts/errors | `sync_outcome` = `partial_failure`, and the log line severity raises to warn |
| 15 | Cancel a sync/export mid-flight | **no** event (cancelled operations must not count) |
| 16 | Save sync settings | `sync_settings_saved` with `auto_sync_enabled`, `sync_scope`, `selected_category_count`, `excluded_category_count`, `has_manual_token` |

## Error reporting (rows 17–18)

1. Temporarily add a line that throws on page load on an uncommitted branch
   (e.g. in a component's render path), or reproduce any known runtime
   error. Expect a request with an exception payload: an error type/message
   and a stack trace. Unhandled promise rejections behave the same.
2. Expect NO payload for ordinary `console.error` calls — console errors are
   deliberately not reported.
3. Revert the temporary throw before committing.

## Identity rows (19–21) — needs a real sign-in server

Your collector cannot answer the app's OIDC sign-in, so identity needs a
running sync server (see [server administration](../../server-admin.md)) or
browser-side inspection:

```js
// in DevTools console, after sign-in:
posthog.get_distinct_id()   // expect "oidc:<issuer-url>:<subject>"
```

| # | Do this | Expect |
|---|---|---|
| 19 | Sign in with analytics enabled | `distinct_id` becomes `oidc:<issuer>:<sub>`; optional `email`/`name`/`preferred_username` set only if the provider supplied them |
| 20 | Sign out | `get_distinct_id()` returns to an anonymous ID (a new value, not the OIDC one); later events carry it |
| 21 | Multi-server: sign out of server A while server B's session exists | identity resets only if the current distinct ID belongs to A; B's attribution stays |

Also verify persistence: sign in, reload the page, and confirm
`get_distinct_id()` is still the OIDC identity without signing in again.

## The off case

1. Rename `.env` to `.env.disabled` and restart `npm run dev`.
2. Expect the app to throw at startup naming the missing variable
   (`VITE_POSTHOG_KEY` or `VITE_POSTHOG_HOST`) — this is the documented
   development behaviour, not a bug.
3. Add a dummy `VITE_POSTHOG_KEY` back (still no host). Expect a throw naming
   `VITE_POSTHOG_HOST`.
4. For the production-shaped case: move `.env` aside, run `npm run build`,
   then `npm run preview` with `.env` still moved aside. Expect NO startup
   error and NO requests to any host: analytics off, app on.
5. Restore `.env`.

> Build mode (`import.meta.env.DEV`) decides throw-vs-silent. The throw must
> appear only in dev; silently staying off is only acceptable in a
> production build.

## Negative checks (privacy)

While the collector runs, confirm the request bodies never contain:

- note text, note titles, tag or category names
- attachment contents or data URLs (only `attachment_type` counts)
- tokens, passwords, or session identifiers (`has_manual_token` is a
  boolean, not the token)

Sample a few events' JSON payloads from the network tab, not just event
names.

## Filing the result

Record per row: pass/fail, the event name(s) seen, and any property that
deviated from [what the app records](../privacy/what-is-recorded.md). For
identity rows, include the redacted distinct ID shape
(`oidc:<issuer>:<subject>`), not raw values, in the report.