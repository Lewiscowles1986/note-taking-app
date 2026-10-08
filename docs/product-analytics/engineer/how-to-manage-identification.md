---
audience: engineer
diataxis: howto
reading-time: ~4 min
staged-files:
  - src/lib/oidcAuth.ts
last-reviewed: 2026-10-08
---

# How to manage user identification

Use this when changing when the app attaches a user identity to analytics
events, or when removing it. All identification lives in
[src/lib/oidcAuth.ts](../../../src/lib/oidcAuth.ts) as two functions:

- `identifyOidcUser` — called after a sign-in completes
  (`completeLogin`), before the pending state is cleared.
- `resetOidcUser` — called during `logout`, after any server-side token
  revocation and before the local session is cleared.

## The rules the current design follows

Keep these when you edit, or events will be misattributed:

1. **The identity is scoped, not raw.** The distinct ID is
   `oidc:<issuer>:<subject>`. The issuer prefix stops two unrelated providers
   that happen to issue the same `sub` claim from being merged into one
   person. Keep `requireIssuer` (it normalises the issuer URL) in the ID.
2. **Reset before re-identify when switching users.** If the SDK already
   holds a different identity, `identifyOidcUser` calls `posthog.reset()`
   first, or one user's events would be stitched onto another's.
3. **Reset only what you recognise.** `resetOidcUser` compares the current
   distinct ID with the ID this server's session produced and resets only on
   a match — signing out of server A must not discard the identity attached
   while using server B's session.
4. **Both are gated and non-fatal.** Each function returns early when
   `VITE_POSTHOG_KEY`/`VITE_POSTHOG_HOST` are unset or there is no `sub`
   claim, and each is `.catch(() => undefined)` at its call site — an
   analytics failure must not fail a sign-in or a sign-out.
5. **Identity survives page reloads.** The SDK persists the identity, so
   identify belongs at the login boundary, not per event or per page load.

## Making a change

1. Edit `identifyOidcUser` or `resetOidcUser` — or their call sites in
   `completeLogin` / `logout` — keeping rules 1–5 above.
2. Check what you send with `identify`: currently only `email`, `name`, and
   `preferred_username` when the provider supplied them, each conditionally
   spread so absent claims become absent properties. Add or remove fields the
   same way, and clear any new field with the privacy team
   ([what the app records](../privacy/what-is-recorded.md)).
3. Verify: sign in with identity enabled and check `get_distinct_id()` in the
   console matches `oidc:<issuer>:<sub>`; sign out and check it returns to an
   anonymous ID; sign in as a different user on the same server and check no
   pre-sign-in events from the second user carry the first user's ID.

## With the PostHog wizard

The wizard can generate identify/reset wiring, but the current version was
written by hand to satisfy the scoped-ID and switch-user rules above. If you
use the wizard here, re-check rules 1–3 against its output before staging —
its default examples identify with raw emails or bare user IDs, which would
violate rule 1.

## Checklist before you commit

- [ ] Distinct IDs remain issuer-scoped
- [ ] Sign-out resets only the matching identity
- [ ] Identify/reset failures cannot break login or logout
- [ ] Any new identity property documented for the privacy team