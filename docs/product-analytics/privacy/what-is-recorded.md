---
audience: privacy
diataxis: explanation
reading-time: ~4 min
staged-files:
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

# What the app records and where it goes

This document lists what the staged product-analytics code sends off the
device, when, and what it deliberately does not send. Read it to review the
change or to answer a data query. For how the code works, see the engineer
documents in the [index](../README.md).

## Where data goes

Events go to the PostHog analytics service at the host configured in
`VITE_POSTHOG_HOST` (the example config points at PostHog's EU region).
The project token and host ship in the app bundle and are not secret. If the
variables are unset, the analytics module is inert in a production build: the
app runs, and nothing is sent.

## What is sent: product events

One event per completed user action, with counts and choices — never note
text:

| Event | Properties sent |
|---|---|
| `note_created`, `note_deleted` | none |
| `note_encrypted` | `encryption_method` |
| `note_decrypted` | none |
| `attachment_added` | `attachment_type` (`image` / `file`) |
| `notes_exported` | `export_format`, `note_count` |
| `notes_imported` | `note_count` |
| `sync_server_added`, `sync_server_removed` | none |
| `sync_completed` | `sync_outcome`, `pushed_count`, `pulled_count`, `deleted_local_count`, `deleted_remote_count`, `error_count` |
| `sync_settings_saved` | `auto_sync_enabled`, `sync_scope`, `selected_category_count`, `excluded_category_count`, `has_manual_token` |

Note contents, titles, tags, and category names are not properties of any
staged event. Counts ("how many notes were exported") are sent; content is
not.

## What is sent: log lines

Sync rounds also emit structured log lines (`sync.round.completed`,
`sync.round.failed`) carrying the same counts as `sync_completed` plus the
service name `note-haven-web` and the build mode. Severity is info / warn /
error by outcome.

## What is sent: errors

Unhandled errors and unhandled promise rejections are reported, with a
browser-supplied stack trace. Console errors are not reported. An error's
stack frames may include URL paths and source lines of the app itself, but
not note content.

## What is sent: identity

On a successful sign-in, events are attached to a constructed ID:
`oidc:<issuer-url>:<subject>`, where `subject` is the provider's user
identifier and the issuer identifies which provider issued it. Optional
profile claims — `email`, `name`, `preferred_username` — are attached only
when the sign-in provider supplied them. On sign-out the identity is cleared
and events return to an anonymous ID. No password, token, or session data is
sent.

## Timing and storage

Events are sent from the browser as actions happen. The SDK persists the
identity (and its own device ID) in browser storage between page loads, so
events after a reload keep the signed-in attribution until sign-out. Note
data itself is synced separately by the app's sync feature under its own
rules — analytics never carries note payloads; the sync counts describe
numbers only.

## Review notes

- `note_encrypted` sends `encryption_method`: a user choice, not content.
- `sync_settings_saved` sends whether a manual token exists
  (`has_manual_token`) — a boolean, not the token.
- If your jurisdiction requires consent handling before analytics runs, the
  current code has no consent gate: setting the two environment variables is
  what turns analytics on. That decision is visible in
  [src/lib/posthog.ts](../../../src/lib/posthog.ts) and worth recording in
  your review.