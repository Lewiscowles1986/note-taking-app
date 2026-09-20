# FAQ: so how are you testing the HTTP boundary?

> **Question:** so how are you testing the HTTP boundary?

**Answer:**

Honest answer: at two levels, with a real gap at the third.

**1. Unit tests (`src/test/sync.test.ts`) — stubbed fetch, contract assertions.**
`makeFetch` is a scriptable `fetch` stub that records every request. So `runSync` is tested at the fetch seam: exact URLs (`/api/notes/{uid}`, percent-encoded), methods, `Authorization: Bearer` headers, payload body shapes, and status handling — `204` vs `200`, `401`/`500` → `SyncError` with context, invalid JSON, malformed manifests, network failures, per-op error collection, abort. The merge *semantics* are fully covered here, but the transport is synthetic.

**2. E2E (`e2e/sync.spec.ts`) — real browser fetch, intercepted at the network layer.**
`page.route()` sits in front of the browser's genuine `fetch` stack. This is meaningfully more real: it's how I caught the actual boundary bug — `Content-Type: application/json` on bodyless GETs turned them into non-simple CORS requests, triggering a preflight my server-side handler didn't answer. The browser does real request serialization; the mock implements real CORS preflight/headers. But responses are still synthesized by Playwright — no real TCP, no real server code.

**3. The gap: nothing tests a real HTTP server implementation.**
No test boots an actual server process and syncs against it — real header round-trips, real serialization, real status-line handling are untested. That's exactly where integration bugs hide (e.g. a server that returns `200` with an empty body where the client expects JSON, or body-size/charset differences).

The clean fix is the thing you just asked about: if I build the reference server on this branch, I add an integration test that boots it on an ephemeral port inside vitest (Node 26 has global `fetch`, and the test env already provides fake-indexeddb + the storage polyfill) and runs the full engine against real server code — manifest, push, pull, delete, tombstone round-trip, auth rejection. Same test also becomes the server's own test suite. Want me to build that?