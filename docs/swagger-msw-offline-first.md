# Swagger + MSW: offline-first API docs and Try-it-out

Design for making the Swagger viewer's Try-it-out work offline-first by
routing requests through MSW (Mock Service Worker), so a spec pasted into a
note can be *exercised* without a network — while still hitting the real API
when one exists.

Status: **design, not yet implemented.** This document is the plan; the
feature lands behind `E2E_MSW`-style gating in phases (below).

## Goals

1. Insert a spec → Try-it-out works **immediately, even offline**, by
   serving mocked responses generated from the spec itself.
2. When online, requests go to the **real server by default**; the mock is a
   fallback (or an explicit toggle), never a silent replacement.
3. Mock state is **durable and editable**: responses live in the note (or a
   per-note mock store in IndexedDB), so a spec author can hand-craft
   responses the way they hand-craft the spec.
4. Zero runtime dependencies added (registry blocks installs — same
   constraint as the rest of the swagger work). MSW is therefore *a design
   shape*, not literally the `msw` npm package: we implement the
   MSW-compatible parts (request interception + handler registry) with the
   browser primitives we already have — a service worker is NOT required
   because we intercept at the `fetch` call site, not the network layer.

## Why call-site interception instead of a service worker

MSW's real architecture uses a Service Worker to intercept network-wide.
That buys fidelity but costs: a SW file to version/serve, scope headaches
under the app's base path, and SW lifecycle churn in tests. We only need to
intercept `fetch` calls that **our own Try-it-out code makes** — we own that
call site. A tiny injectable fetch dispatcher gives us:

- per-note mock handlers (spec-derived) checked before real `fetch`
- zero SW lifecycle issues in E2E
- offline-first with no SW registration changes
- the same code path runs in vitest (jsdom) and Playwright

If we later need to intercept requests made by third-party code (we don't
today), we can swap the dispatcher for a real SW without changing the
handler layer.

## Architecture

```
SwaggerBlock (Try it out click)
  └─ resolveRequest(op, params, body, mode)
       mode: 'auto' | 'live' | 'mock'        ← dropdown next to Try it out
  └─ tryItFetch(req)
       1. if mode === 'mock' → mockStore.lookup(noteId, req) → synthetic Response
       2. if mode === 'live' → fetch(req) → real server (CORS rules apply)
       3. if mode === 'auto' (default):
            online?  → try live; on network failure fall back to mock + banner
            offline? → mock directly + banner "served from mock"
  └─ mockStore (IndexedDB, per note id)
       { noteId, opKey, method+path template, status, headers, body, delayMs }
       — seeded from the spec's declared responses (status + description +
       example/schema sample), editable in the UI, persisted like the
       saved-examples store already is.
```

### Response synthesis from the spec (the "free" mocks)

When no hand-crafted mock exists, generate one from the operation's declared
responses:

- status: the first 2xx code declared (else 200)
- body: the response's `example` → `examples` entry → `sampleFromSchema()` of
  its schema → empty string
- `Content-Type` from the response content key

This is all client-side and reuses `sampleFromSchema`, so a petstore spec
gives realistic-looking payloads offline with zero authoring.

### Hand-crafted mocks in the note

An optional frontmatter key (or a fenced `msw` block alongside the spec)
holds per-operation overrides:

````markdown
```openapi
---
servers:
  - https://petstore3.swagger.io/api/v3
mocks:
  /pet/findByStatus:
    GET:
      - status: 200
        delay: 250
        body: [{ id: 1, name: "Rex", status: "pending" }]
---
openapi: 3.0.3
...
```
````

- `delay` simulates latency so loading states are demonstrable offline.
- Multiple entries per op = scenario list; the mock dropdown lets you pick
  which to serve (error cases included — `status: 404` etc).
- These ride along inside the note content, so they sync/export/import with
  the note itself — no separate storage to manage.

### Offline-first interactions with the existing app

- The **online/offline badge** already exists in the header; the Try-it-out
  panel gains a `mock` chip when a response was served locally, so provenance
  is always visible.
- `navigator.onLine === false` currently hard-refuses requests. With MSW
  semantics: refuse only in `live` mode; `auto` and `mock` serve from the
  mock store. This *replaces* the "Offline — reconnect to send requests"
  error for specs that have mocks (specs without any declared responses keep
  the current refusal, since there'd be nothing truthful to serve).
- IndexedDB keeps note content + mocks available offline already; nothing new
  to persist.

## Bundle impact

Per [bundle-rationalization.md](bundle-rationalization.md): all of this lives
inside the existing lazy `SwaggerBlock` chunk + a new ~2–3 KB
`swaggerMocks.ts` module (handler matching + response synthesis). No new
third-party code. The mock store reuses the Dexie DB (new table, versioned
migration) rather than a parallel storage layer.

## Phases

1. **Phase 1 — response synthesis + mode dropdown.** `auto` falls back to
   spec-derived mocks on network failure. No persistence. E2E: try-it-out
   against an unroutable server returns the spec's declared 200 sample with a
   `mock` provenance chip.
2. **Phase 2 — mock store.** Hand-crafted overrides in a `mocks:` frontmatter
   block; scenario dropdown; delay support; persisted to the note.
3. **Phase 3 — service-worker cache alignment.** Ensure the SW runtime-caches
   the SwaggerBlock/body-form chunks on first use so the whole flow works
   after a hard offline start (precache only the shell).
4. **Phase 4 — (optional) record-and-replay.** A "capture" toggle records
   real responses (status/headers/body) into the mock store while online, so
   teams can replay real API behavior offline. This is the MSW
   `onRequest`/`saveResponse` equivalent.

## Testing strategy

- Unit: handler matching (method+path template with `{param}` substitution),
  response synthesis precedence (example → examples → schema sample), mode
  resolution matrix (online/offline × auto/live/mock).
- Component: mode dropdown, provenance chip, mock scenario picker.
- E2E: insert petstore template with airplane mode on → Try it out →
  spec-declared response renders with `mock` chip; hand-crafted 404 scenario
  serves offline; live mode still refuses offline with the existing message.
- Mutation: `swaggerMocks.ts` joins the scoped Stryker config once it lands.

## Out of scope / non-goals

- Intercepting fetches from other app features (code runner, attachments).
- Recording arbitrary third-party traffic (no generic proxy).
- WebSocket/streaming mocking.
- Serving mocks for *other* notes' specs — handlers are per-note by design.