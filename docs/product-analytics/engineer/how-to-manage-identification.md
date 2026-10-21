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
2. **Reset before re-identify when switching users.** The shim's
   `identify()` does this itself (comparing the SDK's persisted user id),
   so callers should not add their own reset logic.
3. **Reset only what you recognise.** `resetOidcUser` sets state when THIS
   server's login applied an identity, and resets only if so — signing out
   of server A must not discard the identity attached while using server B's
   session. The `oidcDistinctIdApplied` tracker and `posthog.has_identity()`
   gate carry this; keep both.
4. **Neither can fail user flows.** Calls are synchronous fire-and-forget
   through the shim — an analytics failure cannot break a sign-in or
   sign-out, and there is no `catch` to add at call sites. Builds without
   `VITE_POSTHOG_KEY` ship no-op stubs, making these calls free there.
5. **Identity survives page reloads.** The SDK persists the identity once
   applied, so identify belongs at the login boundary, not per event or per
   page load.

## Making a change

1. Edit `identifyOidcUser` or `resetOidcUser` — or their call sites in
   `completeLogin` / `logout` — keeping rules 1–5 above.
2. Check what you send with `identify`: currently only `email`, `name`, and
   `preferred_username` when the provider supplied them, each conditionally
   spread so absent claims become absent properties. Add or remove fields the
   same way, and clear any new field with the privacy team
   ([what the app records](../privacy/what-is-recorded.md)).
3. Verify: sign in with analytics enabled and check the distinct ID matches
   `oidc:<issuer>:<sub>` (in DevTools: `posthog.get_distinct_id()`);
   sign out and check it returns to an anonymous ID; sign in as a different
   user on the same server and check no pre-sign-in events from the second
   user carry the first user's ID.

## With the PostHog wizard

The wizard can generate identify/reset wiring, but the current version was
written by hand to satisfy the scoped-ID and switch-user rules above. If you
use the wizard here, re-check rules 1–3 against its output before staging —
its default examples identify with raw emails or bare user IDs, which would
violate rule 1, and call the SDK directly rather than through the shim,
which would put the SDK back in the eager bundle.

## Checklist before you commit

- [ ] Distinct IDs remain issuer-scoped
- [ ] Sign-out resets only the matching identity
- [ ] Identify/reset failures cannot break login or logout
- [ ] Any new identity property documented for the privacy team