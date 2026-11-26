# Design: an Electron target that needs no download

Branch: `feat/electron-fork`
Date: 2026-11-25

## Problem

Note Haven ships as a PWA: everything a user runs is fetched from a web origin
and cached by a service worker after first visit. The first load is a download,
and the wasm runtime matrices are deliberately excluded from the precache
(`vite.config.ts`, `globIgnores: ["**/*-wasm/**"]`), so running Python, Ruby or
PHP for the first time always reaches the network.

We want a second build target — a desktop app where the application *is* the
installed bytes. No origin to fetch from, no precache warm-up, no network at
all. The web target must keep working exactly as it does today, and must remain
the default: everything below is behind a flag that is off unless set.

This is a spike. The goal is to prove the shell, the origin story and the
offline payload; installers and signing are planned but not built here.

## Scope

**In:**

- A build-mode flag that produces an Electron-shaped renderer build.
- `electron/` — main process, an embedded HTTP server, asar-aware paths.
- An `npm run` path that launches the built app, plus a dev path with HMR.
- Tests for the server's middleware pipeline (Node-level, no Electron).

**Out (deferred, with the seams named below):**

- `electron-builder` installers (dmg / nsis / AppImage), code signing,
  auto-update.
- Running the sync server inside the app (see "Seam: sync server in-app").
- Any native filesystem integration — the renderer keeps using IndexedDB.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Renderer origin | Embedded HTTP server on a **fixed** loopback port | Real web origin: IndexedDB, `localStorage`, `fetch`, `DecompressionStream`, `crypto.subtle` all behave as on the web |
| Server process | `utilityProcess.fork()` from main | Node environment in the same Electron executable; no second binary to build or ship; keeps wasm I/O off the main process |
| Server shape | Middleware pipeline, static assets as one middleware | A future build can compose the sync server onto the same listener |
| Code layout | `electron/` + Electron deps in the root `package.json` | One install, one lockfile; the desktop build tracks the web app's dependencies |
| Wasm payload | `VITE_LANGUAGES` (already implemented) | Slim / PHP-only / Python-only desktop builds come free |
| Sync in the desktop app | Build option, on by default | `VITE_NO_SYNC=1` already stubs it out for a strictly local build |
| Packaging | Later pass | Spike first |

## Architecture

```
electron/main.mjs             app lifecycle, single-instance lock, window, navigation guards
electron/server.mjs           createApp({ middlewares }) + staticAssets(root); no Electron import
electron/server-process.mjs   utility-process entry: env → chain → { type: "ready", port }
electron/paths.mjs            asar-aware resolution of the built renderer root
```

### Process lifecycle

`main.mjs` forks `server.mjs` with `utilityProcess.fork()`. The child listens on
`127.0.0.1` and posts `{ type: "ready", port }` over `parentPort`; main resolves
a promise on that message and only then creates the window and loads the URL.
If the child exits or errors, main shows a dialog and quits rather than leaving
a window pointing at nothing. `before-quit` kills the child.

The server never picks a port at random. See the next section.

### Origin stability — the one non-negotiable

The loopback URL is the renderer's origin, and IndexedDB — every note the user
has — is keyed by origin. Therefore:

- The port is a **fixed constant**, overridable only through an environment
  variable used by dev.
- A port collision is a **hard failure** with a clear dialog. It must never fall
  back to another port, because a different port is a silently empty note store.
- `app.requestSingleInstanceLock()` prevents two launches competing for it.

Loopback IPs are potentially-trustworthy origins, so `crypto.subtle`
(encrypted notes), `DecompressionStream` (gzipped wasm), and `isSecureContext`
all work. `base: "/"` means `BrowserRouter` in `src/App.tsx` needs no change.

### Data location and migration

Notes live in Electron's `userData` profile, which is **separate from the
browser**. A first run is empty. Users bring notes across with the existing
JSON/ZIP export → import. This is a documented migration step, not an automatic
one; silently copying browser data into an app profile is not something a
design should do implicitly.

### Security posture

Bind `127.0.0.1` only. Validate the `Host` header — that is what stops DNS
rebinding from a web page reaching the local server. No CORS headers are sent.
Reject path traversal after URL-decoding. The window sets
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and refuses
to navigate away from the origin.

There is no write API in this build and IndexedDB is not readable
cross-origin, so the exposure is "another local process can read files that are
already public in `public/`".

## Server: middleware, not a static file server

`server.mjs` exposes:

```js
createApp({ middlewares })   // → (req, res) listener; runs the chain, then 404
staticAssets(root)           // → a middleware; the only one shipped today
```

A middleware is `(req, res, next)`, matching the conventions already used in
[`server/http-utils.mjs`](../../server/http-utils.mjs) (`HttpError`, `sendJson`,
body caps). `staticAssets` handles `GET`/`HEAD`, resolves the path against
`root`, applies the MIME table, and calls `next()` when there is no file — so a
later middleware can answer.

Today the chain is `[staticAssets(root)]`.

### Seam: sync server in-app

`electron/` does not import `server/`. But because the listener is a middleware
chain, a future build can compose the existing `createRouter()` from
[`server/routes.mjs`](../../server/routes.mjs) as another middleware. Sync would
then share the app's origin: no CORS, no cross-origin token plumbing, and the
existing sync client works unchanged.

Two things make that a real piece of work rather than a wiring exercise, and
they are recorded here so the seam is not mistaken for a ready feature:

- The reference server seeds dev users unconditionally
  ([`server/seed.mjs`](../../server/seed.mjs)) and its OIDC clients pin
  `redirect_uris` to `http://localhost:4173/auth/callback`. An embedded instance
  needs seeding off by default and the redirect URI derived from the actual
  origin.
- The server's data directory must live under Electron `userData`, not
  `server/data`.

### Two asset traps

- **A `.gz` file must not be served with `Content-Encoding: gzip`.** The wasm
  bundles are committed gzipped and decompressed in JS by
  [`src/lib/wasmAssets.ts`](../../src/lib/wasmAssets.ts). A server that infers
  encoding from the extension would double-decompress and break every code
  runner. Serve them as opaque bytes (`application/octet-stream`).
- `.wasm` → `application/wasm`, `.mjs` → a JavaScript MIME, `.json` →
  `application/json`. Streaming compile and module loading fail otherwise.

## Vite changes

One flag, following the existing `VITE_NO_SYNC` pattern in
[`vite.config.ts`](../../vite.config.ts):

- `VITE_ELECTRON=1` skips `VitePWA` (a desktop app has no use for a precache
  service worker, and a stale profile worker after an upgrade is a real bug) and
  builds to `dist-electron/` with `base: "/"`.
- Default off: `build`, `build:nosync`, language pruning and CI are unchanged.

| script | does |
|---|---|
| `build:electron` | `VITE_ELECTRON=1 vite build --outDir dist-electron --emptyOutDir` |
| `electron:start` | launches Electron against the built assets |
| `electron:dev` | Vite dev server on :8080, Electron pointed at it (HMR; separate origin, separate dev data) |

`VITE_LANGUAGES` already prunes unenabled `*-wasm` directories from the output,
so a slim / PHP-only / Python-only desktop build is
`VITE_LANGUAGES=php npm run build:electron`.

## Testing

`server.mjs` exports `createApp` and `staticAssets`, so tests bind an ephemeral
port and assert on the pipeline directly — no Electron required:

- MIME mapping for `.mjs`, `.wasm`, `.json`, `.html`, `.css`.
- `.gz` delivered as opaque bytes with no `Content-Encoding`.
- `Host` header validation and traversal rejection.
- `next()` falling through to a later middleware (the seam above).
- SPA fallback to `index.html` for an extensionless path.

The full app is verified by launching the built app and exercising a note and a
code block offline. Not part of `npm run test:e2e`, which stays a browser suite.

## Long-term plan

1. This spike: shell + origin + offline payload validated locally.
2. `electron-builder` targets — dmg (macOS arm64/x64), nsis (Windows), AppImage
   (Linux) — with signing and notarisation following the platform realities.
3. Optional in-app sync server via the middleware seam, behind an opt-in build
   flag.
