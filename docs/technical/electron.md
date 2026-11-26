# The Electron desktop target

## What this target is

The web app is a PWA: the code you run is fetched from an origin and cached by a
service worker after the first visit. The Electron target is the other shape —
the application **is** the installed bytes. Nothing is fetched at run time: no
precache warm-up, no first-run download of a wasm runtime, no network at all.

It is a **second** target. The web build is still the default and is unchanged;
everything here sits behind `VITE_ELECTRON=1`, which is off unless you set it.

This is currently a spike: a shell, the origin story and the offline payload.
Installers now build (see [Packaging](#packaging)); signing and auto-update are
not done yet.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build:electron` | Vite build with `VITE_ELECTRON=1` into `dist-electron/` (no service worker) |
| `npm run electron:start` | Launch Electron against `dist-electron/` |
| `npm run electron:dev` | Electron pointed at the Vite dev server (`npm run dev` in a second terminal) — HMR |
| `npm run electron:serve` | Serve `dist-electron/` on `http://127.0.0.1:4173/` with no GUI, for poking in a browser |
| `npm run test:electron` | The server test suite (`node --test`), no Electron required |
| `npm run electron:pack` | Package an unpacked `.app` into `release/` (no installer) |
| `npm run electron:dist:mac` | Build macOS dmg + zip for the current architecture |

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
- A server that dies **mid-session** is restarted, not fatal. The restart reuses
  the same port for the same reason launch refuses to move: the note store is
  keyed by the origin, so a different port would open a different, empty
  library.
- `NOTE_HAVEN_PORT` overrides the port (used for dev and testing). Changing it
  changes where your notes live.
- A single-instance lock stops a second launch from competing for the port.
- If the app is **Force Quit** (or crashes), the forked server would otherwise
  outlive its parent and keep holding 4173, so the next launch could not bind.
  The child therefore watches the parent pid it is given in
  `NOTE_HAVEN_PARENT_PID` and closes the listener when that process goes away.

Loopback addresses count as potentially-trustworthy origins, so the secure-context
APIs work without any certificate or special casing.

## Testing the restart by hand

The `justfile` at the repo root drives the loop:

```bash
just electron         # build the renderer and launch the app (:4173)
just server-status    # note the pid
just kill-server      # in another terminal
just server-status    # a different pid: the app rebooted the server
```

`just watch-server` polls the port once a second and prints the pid whenever it
changes, which makes the restart visible as it happens. `just web` runs the
browser build on :8080 instead.

Use the built app (`just electron`), not `npm run electron:dev`: the dev target
points at the Vite server and starts no embedded server at all, so there would be
nothing to kill.

## Your notes are not shared with the browser

Electron keeps its data in its own `userData` profile, which is **separate from
your browser**. A first run is an empty app, and the web app's notes are not
visible to it. That is deliberate: copying browser storage into an application
profile behind the user's back is not something this design does.

Move notes across with the existing **Export → Import** flow (JSON or ZIP).

On macOS that profile is `~/Library/Application Support/Note Haven/`, and the
notes themselves are the IndexedDB directory inside it — named after the origin,
so `IndexedDB/http_127.0.0.1_4173.indexeddb.leveldb/`. This is why the port is
part of the note store's identity: a different port is a different directory, and
therefore a different, empty library.

The directory follows `productName` (`Note Haven`), not `appId`. Renaming the
product moves where the notes live; changing `appId` does not.

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
electron/lifecycle.mjs        restart-or-dialog decision for a server exit, and the backoff policy
electron/parent-watch.mjs     exits the server when the app that owns it is gone
```

`main.mjs` forks `server-process.mjs` with `utilityProcess.fork()`, waits for the
child's `ready` message, and only then creates the window.

That **initial** start is strict. If it fails, the app says so and quits: a port
collision is fatal, and there is no useful window to show without a server.

An exit **after** a successful start is not fatal. The app restarts the child on
the same port 4173 and reloads the window once it reports `ready` again.
Restarts back off — 250 ms times the attempt number, capped at 5 s — and the
attempt counter resets after 10 s of healthy uptime, so one crash costs nothing
while a crash loop cannot spin. It is repeatable: every unexpected exit takes
that path, not just the first.

A normal quit stays silent. Quitting kills the child, and that exit is neither
reported nor restarted.

Two details keep those reports honest:

- **Only an unrequested exit is reported.** Quitting kills the child, so a clean
  quit also produces an `exit` event. `before-quit` records the intent first, and
  `lifecycle.mjs` suppresses the "Note Haven stopped" dialog from then on — it
  appears at most once, and only when the server really did stop on its own.
- **The child does not outlive the app.** A Force Quit or crash skips the quit
  path entirely, leaving the server holding port 4173. `parent-watch.mjs` makes
  the child exit once the `NOTE_HAVEN_PARENT_PID` it was started with is gone, so
  the next launch can bind.

A bind failure (`EADDRINUSE`) is posted back by the child before it exits, and
`main.mjs` surfaces that message rather than a bare exit code.

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

## Packaging

`electron-builder` produces installers from the same `dist-electron/` the dev
commands use. Configuration lives in `electron-builder.yml`.

```bash
npm run electron:dist:mac                   # this machine's architecture
npx electron-builder --mac --universal      # one app for Intel + Apple Silicon
```

`node_modules/` is deliberately **not** packaged. Every runtime dependency is
bundled by Vite into `dist-electron/`, and the Electron shell imports only
`node:` builtins, so shipping dependencies would add hundreds of megabytes of
code that never executes. The packaged `app.asar` is the shell plus the built
app.

### Universal builds and the macOS floor

A universal build is one `.app` containing both the arm64 and x64 Electron
frameworks, merged by `lipo`. It is the right artifact when you want a single
download for every Mac.

**The OS floor is set by Electron, not by configuration.** Electron 45's
framework declares `LSMinimumSystemVersion` 13.0, and `electron-builder`'s
`minimumSystemVersion` option only records that requirement in the bundle's
`Info.plist` — it cannot lower it. Declaring 11.0 would not make the app run
there; `dyld` would fail to load the framework. To genuinely support macOS 12 or
older, the Electron major version has to come down, and that is a dependency
decision rather than a packaging one.

The floor is therefore pinned to `13.0` in `electron-builder.yml` so the bundle
states what is actually true. If you need a different floor, change the Electron
version and update that value to match the new framework's declared minimum.

### Signing

The config uses `identity: null`, which produces an **ad-hoc** signature. That is
the minimum for an arm64 macOS app to execute at all, and it is enough to run a
build you made yourself. It is **not** notarisation: a downloaded copy carries
the quarantine flag, so macOS refuses the first launch. Either right-click the
app and choose **Open**, or clear the flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/Note Haven.app"
```

Adding a Developer ID certificate and notarisation would remove that step and is
the natural next change; it needs Apple credentials as repository secrets, so it
is not wired up.

### CI

`.github/workflows/electron.yml` builds on a macOS runner — `lipo` and `hdiutil`
are Darwin-only, and a Linux runner cannot produce a valid universal bundle or a
dmg. It:

- runs the Electron server suite;
- builds the renderer once (it is architecture-independent);
- packages whatever `mac-arch` you pick (`universal`, `arm64`, `x64`);
- asserts the bundle is really universal, that the identifier and OS floor are
  the configured ones, and that **every** vendored wasm runtime made it into
  `app.asar`;
- uploads the dmg and zip as workflow artifacts.

Run it from **Actions → Electron → Run workflow**, or by pushing a `v*` tag. It
does not publish a release; download the artifact from the run instead.

`appId` is `com.lewiscowles.notehaven` — the bundle identifier, which is what
signing and Gatekeeper see. It is **not** where the data lives: `userData`
follows `productName` (see above), so renaming the product is the change that
moves a user's notes.

## Not done yet

- Code signing with a Developer ID and notarisation (see [Signing](#signing)),
  and auto-update.
- Any native filesystem integration — the renderer keeps using IndexedDB.
