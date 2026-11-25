# The Electron desktop target

## What this target is

The web app is a PWA: the code you run is fetched from an origin and cached by a
service worker after the first visit. The Electron target is the other shape —
the application **is** the installed bytes. Nothing is fetched at run time: no
precache warm-up, no first-run download of a wasm runtime, no network at all.

It is a **second** target. The web build is still the default and is unchanged;
everything here sits behind `VITE_ELECTRON=1`, which is off unless you set it.

This is currently a spike: a shell, the origin story and the offline payload.
Installers, signing and auto-update are not built yet (see the end of this page).

## Commands

| Command | What it does |
| --- | --- |
| `npm run build:electron` | Vite build with `VITE_ELECTRON=1` into `dist-electron/` (no service worker) |
| `npm run electron:start` | Launch Electron against `dist-electron/` |
| `npm run electron:dev` | Electron pointed at the Vite dev server (`npm run dev` in a second terminal) — HMR |
| `npm run electron:serve` | Serve `dist-electron/` on `http://127.0.0.1:4173/` with no GUI, for poking in a browser |
| `npm run test:electron` | The server test suite (`node --test`), no Electron required |

A normal run:

```bash
npm run build:electron
npm run electron:start
```

Because the assets are served over HTTP rather than loaded from `file://`, the
renderer gets a real web origin — IndexedDB, `localStorage`, `fetch`,
`DecompressionStream` and `crypto.subtle` (encrypted notes) all behave exactly as
they do on the web.

## The origin rule

The loopback URL is the renderer's origin, and **IndexedDB keeps every note
against that origin**. The port is therefore fixed at **4173**, not chosen at
runtime:

- A collision is a **hard failure**. The app shows a dialog naming the port and
  quits; it never silently moves to another port, because a different port means
  a different, empty note store.
- `NOTE_HAVEN_PORT` overrides the port (used for dev and testing). Changing it
  changes where your notes live.
- A single-instance lock stops a second launch from competing for the port.

Loopback addresses count as potentially-trustworthy origins, so the secure-context
APIs work without any certificate or special casing.

## Your notes are not shared with the browser

Electron keeps its data in its own `userData` profile, which is **separate from
your browser**. A first run is an empty app, and the web app's notes are not
visible to it. That is deliberate: copying browser storage into an application
profile behind the user's back is not something this design does.

Move notes across with the existing **Export → Import** flow (JSON or ZIP).

## Choosing the wasm payload

`VITE_LANGUAGES` already prunes the runtimes a build does not need, and it
composes with the desktop target:

```bash
VITE_LANGUAGES=php npm run build:electron   # only the PHP runtime ships
```

The default is `js,php,python,ruby`, matching the web build.

## Sync

Sync is on by default, like the web app. For a strictly local desktop build:

```bash
VITE_NO_SYNC=1 VITE_ELECTRON=1 npm run build:electron
```

Running the sync **server** inside the app is a future seam, not a feature. The
server is a middleware pipeline, so the existing router can be composed onto the
same listener — but two things need doing first (unconditional dev-user seeding
and `redirect_uris` pinned to a fixed port). Both are recorded in the
[design doc](../plans/2026-11-25-electron-fork-design.md#seam-sync-server-in-app).

## How it is put together

```
electron/main.mjs             app lifecycle, single-instance lock, window, navigation guards
electron/server.mjs           createApp({ middlewares }) + staticAssets(root); no Electron import
electron/server-process.mjs   utility-process entry: env → chain → { type: "ready", port }
electron/paths.mjs            asar-aware resolution of the built renderer root
```

`main.mjs` forks `server-process.mjs` with `utilityProcess.fork()`, waits for the
child's `ready` message, and only then creates the window. If the child dies the
app reports it and quits rather than leaving a window pointing at nothing.

`server.mjs` has no Electron import, which is why `npm run test:electron` can
exercise the whole HTTP layer in plain Node. The only security-sensitive details
worth knowing while editing it:

- The `Host` header is validated; that is what stops DNS rebinding from a web
  page reaching the local server. Foreign hosts get `421`.
- Path traversal is rejected after URL-decoding, and anything outside the root is
  a `404`.
- `.gz` is served as opaque `application/octet-stream` with **no**
  `Content-Encoding`. The vendored wasm bundles are committed gzipped and
  decompressed in JS; a `Content-Encoding: gzip` header would double-decompress
  them and break every code runner.

## Not done yet

- `electron-builder` installers (dmg / nsis / AppImage), code signing, notarisation
  and auto-update.
- Any native filesystem integration — the renderer keeps using IndexedDB.
