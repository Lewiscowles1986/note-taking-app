---
audience: user
diataxis: explanation
reading-time: ~3 min
staged-files:
  - src/lib/posthog.ts
  - src/lib/oidcAuth.ts
last-reviewed: 2026-10-08
---

# What's recorded when you use the app

A new version of the app can record simple usage facts and send them to an
analytics service. This page says what is recorded, what is not, and what
that means for your notes.

## What is recorded

The app counts actions — that a note was created, deleted, exported,
encrypted, or decrypted; that a file was attached; that a sync finished and
how many notes moved; that a sync server was added or removed. Each counted
action carries a few numbers or a choice — for example, how many notes an
export contained, or which format it used.

The app also reports when something inside it breaks (an error it didn't
handle), so that problems can be fixed.

## What is not recorded

Your note text, titles, tags, and category names are never included in what
is sent. Attachments are never uploaded to the analytics service — the app
only records that an attachment was added, and what kind. Passwords, sign-in
tokens, and session data are never sent.

## Where it goes and when it stops

Sent data goes to PostHog, an analytics service, from your browser as you
use the app. The version you run decides whether this happens at all: the
people who build or host your copy of the app enable it by configuration,
and a copy built without that setting contains no analytics code. If it is
not enabled, nothing is sent and nothing is stored.

When you sign in to a sync server, your counted actions are linked to a
sign-in identifier so the app can tell accounts apart. The identifier is
built from your sign-in provider's address and its ID for you — not your
password. Your email or display name may be attached if your sign-in
provider supplies them. When you sign out, that link is removed and actions
are counted without a name again.

## What this changes for you

- Your notes and their contents behave exactly as before. Nothing about how
  notes are stored, encrypted, or synced is affected; the counted actions
  are separate from note syncing.
- Blocking the analytics service in your browser or network also stops the
  data from being sent, with no error or warning shown. The app keeps
  working without it.
- If you prefer that no usage data is sent, say so to whoever provides your
  copy of the app — they can produce a build without it by leaving one
  configuration value unset.

## Common questions

**Does encryption stop my notes being seen?**
Encryption protects note content, which isn't sent anyway. The counted
actions (for example, that a note was encrypted, and which method was used)
are separate from the content.

**Can I see what was sent?**
The data goes to the operator of your app copy, not to a page you can open.
This document — and the more detailed list in
[what the app records](../privacy/what-is-recorded.md) — is the reference
for what is included.