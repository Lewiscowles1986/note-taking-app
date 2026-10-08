---
audience: engineer
diataxis: howto
reading-time: ~2 min
staged-files:
  - src/lib/posthogLogs.ts
  - src/pages/ServersPage.tsx
  - src/pages/SettingsPage.tsx
last-reviewed: 2026-10-08
---

# How to add a structured log event

Use this when a recurring operation should produce a log line with numbers
and an outcome, rather than a one-off click event. Structured logs go through
`posthog.logger` and carry the `note-haven-web` service name set at init.
The only current example is sync reporting in
[src/lib/posthogLogs.ts](../../../src/lib/posthogLogs.ts), called from
[src/pages/ServersPage.tsx](../../../src/pages/ServersPage.tsx) and
[src/pages/SettingsPage.tsx](../../../src/pages/SettingsPage.tsx).

## By hand

1. Add helpers to [src/lib/posthogLogs.ts](../../../src/lib/posthogLogs.ts),
   importing `posthog` from `@/lib/posthog`. Keep the module as the single
   place where log payloads are shaped, so pages stay free of payload code.
2. Give every log line an `event` attribute (`sync.round.completed` —
   dot-separated, past tense) so lines can be grouped by type in the
   analytics tool.
3. Attach counts as typed attributes following the property style in the
   how-to for [analytics events](how-to-add-analytics-event.md):
   `pushed_count`, `error_count`, and so on.
4. Pick severity by outcome, not by volume: `info` when the operation
   succeeded, `warn` when it completed with problems, `error` only when it
   failed outright. The current file maps `ok` → info, `partial_failure` →
   warn, and a thrown sync → error via `logSyncFailure`.
5. Call the helpers from the page after the operation settles — in the
   staged code, after `runSync` resolves and in the catch block, mirroring
   the `posthog.capture('sync_completed', ...)` call next to it.
6. Note the deliberate duplication: pages currently emit both a countable
   event and a log line per sync. If you add a third consumer of the same
   payload, move the duplicated attribute object into the helper's return
   value or a shared builder rather than copying it again.

## With the PostHog wizard

1. Run the wizard and describe the operation to log.
2. Review the generated call sites — the wizard tends to log inline in the
   page; move the payload shaping into `posthogLogs.ts` first if you want to
   keep the current separation.
3. Check it did not also register duplicate event names or change severities.

## Checklist before you commit

- [ ] `event` attribute present on every log line
- [ ] Severity matches outcome (info / warn / error)
- [ ] Payload shaping stays in `posthogLogs.ts`
- [ ] `npm run lint` and `npm run test` pass