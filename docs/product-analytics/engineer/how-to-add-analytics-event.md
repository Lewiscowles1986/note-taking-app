---
audience: engineer
diataxis: howto
reading-time: ~3 min
staged-files:
  - src/pages/Index.tsx
  - src/components/NoteEditor.tsx
  - src/components/NoteSidebar.tsx
  - src/hooks/useNotes.ts
last-reviewed: 2026-10-08
---

# How to add an analytics event

Use this when a user action should be counted. A "change" is one event name at
one call site, with names agreed for the properties it carries. Existing
examples: `note_created` ([src/pages/Index.tsx](../../../src/pages/Index.tsx)),
`attachment_added` ([src/components/NoteEditor.tsx](../../../src/components/NoteEditor.tsx)),
`notes_exported` and `notes_imported`
([src/components/NoteSidebar.tsx](../../../src/components/NoteSidebar.tsx)),
`note_deleted` ([src/hooks/useNotes.ts](../../../src/hooks/useNotes.ts)),
`note_encrypted` / `note_decrypted` ([src/pages/Index.tsx](../../../src/pages/Index.tsx)),
the rendered/run events in
[src/components/CodeBlock.tsx](../../../src/components/CodeBlock.tsx), and
the sync events in [src/pages/ServersPage.tsx](../../../src/pages/ServersPage.tsx)
and [src/pages/SettingsPage.tsx](../../../src/pages/SettingsPage.tsx).

## By hand

1. Import the shim in the file where the action happens:
   `import { capture as posthogCapture } from '@/lib/posthog';`
2. Choose an event name: `snake_case`, named for the completed fact —
   `note_created`, not `create_note`. If a similar event exists (for example
   the `notes_exported` family, told apart by an `export_format` property),
   reuse it rather than adding a near-duplicate name.
3. Add the call at the point the action has fully succeeded — after the
   operation's `await` in the staged code, so a failed operation doesn't
   count as done. Example shape:

   ```ts
   posthogCapture('note_created');
   ```

   or with properties:

   ```ts
   posthogCapture('attachment_added', { attachment_type: 'image' });
   ```

   The call is fire-and-forget: it queues and never blocks or rejects, so
   there is no error path to handle.
4. Follow the property style already in use: counts end in `_count`, booleans
   in `has_`/`is_`, choices in `snake_case` (`sync_outcome`, `export_format`).
   Keep note contents, titles, and category names out of properties.
5. Verify: run the app, perform the action, and check the event appears in
   the network tab addressed to the configured host (or a local collector —
   see the [QA runbook](../qa/how-to-verify-analytics.md)).

## With the PostHog wizard

1. Run the wizard and describe the action to instrument.
2. Review the diff before staging — check the placement (after success, not
   before), the event name, and the properties it chose. If the wizard
   writes `posthog.capture(...)` against a module-level SDK import, adapt it
   to the shim call (`posthogCapture`) so the SDK stays lazy.
3. If the wizard adds an event that overlaps an existing one, align the names
   before merging, or you will get two events for one concept.

## Checklist before you commit

- [ ] Event fires once per action (beware handlers that retry)
- [ ] No note content, titles, or category names in properties
- [ ] Placement is after success, including error paths
- [ ] `npm run lint` and `npm run test` pass