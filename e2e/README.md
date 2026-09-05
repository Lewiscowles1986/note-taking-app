# E2E Test Suite

End-to-end tests for **Note Haven** (React 18 + Vite + TS + Tailwind + Dexie/IndexedDB),
driven by [Playwright](https://playwright.dev/) 1.58.x, Chromium only.

## Purpose

These tests exercise the real app in a real browser against a real IndexedDB. They
cover the core note-taking flows (create/edit/delete/pin/tag/category/search), the
Markdown editor (slash commands, callouts, code blocks, mermaid, GFM), the calendar
view, encryption (password + RSA key pairs), and export/import (HTML, ZIP, DB
backup, key-pair JWK).

The suite is deliberately **local-first**: every test wipes IndexedDB before the app
loads, so tests are independent, deterministic, and need no backend or fixtures.

## How to run

From the repo root (the worktree):

```bash
# Full suite, both projects (headless)
npm run test:e2e

# A single project
npx playwright test --project=chromium          # desktop 1440x900 — full suite
npx playwright test --project=chromium-mobile    # mobile — real Pixel 7 viewport, runs only *mobile*.spec.ts

# A single spec file
npx playwright test e2e/security.spec.ts

# A single test by title
npx playwright test -g "exports a generated key pair as JWK"

# Headed (watch the browser) + debug
npx playwright test --headed
npx playwright test --debug
```

The `webServer` config auto-starts `npx vite --port 5173 --strictPort` and reuses an
already-running dev server when present.

## Mobile, PWA/offline & device smoke

- **`chromium-mobile` project scope.** It is a *genuine phone* (`devices['Pixel 7']`:
  real viewport, touch, and `window.innerWidth < 768`, so the mobile branch of the UI
  is exercised). It is scoped with `testMatch: '**/*mobile*.spec.ts'` so only the
  mobile-targeted specs run at phone width — the desktop specs assume an
  always-visible `.w-72` sidebar that mobile replaces with a top sheet, so running
  them at a phone viewport was wrong. `app.spec.ts` runs under `chromium` only.
- **PWA / service-worker offline coverage** — `npm run test:e2e:pwa` runs
  `e2e/offline.mobile.spec.ts` against a *production* `vite preview` build (the
  service worker is only emitted at build time, never in dev). It asserts the SW
  caches the shell and a seeded note still loads while offline. The spec is
  `test.skip`-gated on `E2E_PWA=1`, so it is skipped in normal runs.
- **The browser suite is the primary regression layer.** See
  [`docs/mobile-qa.md`](../../docs/mobile-qa.md) for the layered strategy: the
  deterministic Playwright suite (both projects) is the every-commit backstop, while
  the iOS Simulator (`scripts/ios-smoke.sh`, real WebKit/Safari — the only place
  safe-area `env()` and `100dvh` are visible) and Android emulator
  (`scripts/android-smoke.sh`) smokes are targeted on-demand device checks that
  complement — not replace — the browser suite.

## Run modes

Three environment-driven modes coexist, controlled by four env vars:
`E2E_BASE_URL` (attach mode), `E2E_BASE_PATH` (app-root path), `E2E_DEBUG` (debug
mode) and `E2E_NO_SCREENSHOTS` (no-screenshot mode). They combine freely.

| Mode | Command | Behavior |
| --- | --- | --- |
| **Default** | `npm run test:e2e` | Playwright starts `vite` on **5173** (`--strictPort`) and runs headless, parallel. |
| **Attach** | `E2E_BASE_URL=http://host:port npm run test:e2e` | **No server is started** — tests attach to the already-running server at that URL. Use against a preview/CI build or a dev server on a non-default port. |
| **Debug** | `npm run test:e2e:debug` (or `E2E_DEBUG=1 npx playwright test -g "encrypts a note"`) | **Headed**, serial (`workers: 1`), no retries. Every test pauses at its labeled `debugBreak` drop-in before the assertion cluster. |
| **No screenshots** | `E2E_NO_SCREENSHOTS=1 npm run test:e2e` | Failure screenshots off, retry traces off (trace archives embed screenshots), `step()` is a no-op. **No image artifacts at all.** |

- **Attach mode** (`E2E_BASE_URL` set): `webServer` is disabled entirely, so Playwright
  never boots its own vite. The value must be an absolute `http(s)` URL (a trailing
  slash is tolerated and stripped; anything else fails fast with a clear config error).
  Nothing else in the config references the hardcoded 5173 at runtime in this mode.
- **App-root path** (`E2E_BASE_PATH`, default `/`): every spec navigates with
  `page.goto(APP_PATH)` from `e2e/app-path.ts` instead of a hardcoded `"/"`, because
  Playwright resolves an absolute path against the ORIGIN root — a deployment under a
  sub-path (e.g. GitHub Pages at `https://user.github.io/<repo>/`) would otherwise
  404 every navigation. Resolution order: explicit `E2E_BASE_PATH` wins; otherwise the
  path of `E2E_BASE_URL` is used (the app is served at the attach URL, so its pathname
  is the app root); otherwise `/`. Trailing slashes are stripped, so attaching to
  `https://user.github.io/<repo>/` needs no extra variable — the GitHub Pages run is
  just `E2E_BASE_URL=https://lewiscowles1986.github.io/note-taking-app/ npm run test:e2e:remote`.
- **Debug mode** (`E2E_DEBUG=1` or `E2E_DEBUG=true`): forces `headless: false`,
  `workers: 1`, `retries: 0` for a single deterministic headed window. Each test calls
  `debugBreak(page, "<label>")` after the primary state is established and before its
  main assertions. The helper logs a banner and calls `page.pause()`, opening the
  Playwright Inspector — interact with the app, then click **Resume**. Because every
  test pauses, filter with `-g` to target one test. `page.pause()` is a no-op in
  headless (Playwright 1.58.x), so it never hangs, but debug mode forces headed so the
  Inspector actually opens.
- **No-screenshot mode** (`E2E_NO_SCREENSHOTS=1` or `E2E_NO_SCREENSHOTS=true`):
  `screenshot: 'off'` and `trace: 'off'` in the config, and the `step()` helper in
  `e2e/fixtures.ts` becomes a no-op, so a run leaves no image artifacts anywhere. It
  does not touch the two `toHaveScreenshot` baselines in `app.spec.ts` (those are
  assertions, not artifacts) — pass `--ignore-snapshots` to skip those too. The
  intended combination is a remote attach run:

  ```bash
  E2E_BASE_URL=http://host:port npm run test:e2e:remote
  ```

  which is `E2E_NO_SCREENSHOTS=1 playwright test --ignore-snapshots` against your URL.
- **Combined**: `E2E_DEBUG=1 E2E_BASE_URL=http://host:port npx playwright test -g "..."`
  attaches to your server and pauses headed.
- **PWDEBUG=1** is also compatible: it opens the Inspector on the first action of every
  test (a different, action-level breakpoint than the labeled `debugBreak` drop-ins).
  `PWDEBUG=1` implies headed + serial on its own.

### Updating snapshots

`app.spec.ts` uses `toHaveScreenshot` baselines stored in
`e2e/app.spec.ts-snapshots/`. If a deliberate UI change breaks them, regenerate
**only that spec** and review the diff:

```bash
npx playwright test e2e/app.spec.ts --update-snapshots
```

Then prove the no-update run still passes (see "Regenerating baselines" below).

## Fixture architecture (`e2e/fixtures.ts`)

- **`test` / `expect`** — the extended Playwright `test`/`expect` re-exported for
  every spec. The autouse **`freshDb`** fixture injects an init script that deletes
  the `NotesApp` IndexedDB before the app opens, guaranteeing a clean DB per test.
  It is guarded by `sessionStorage` so a mid-test `page.reload()` does not wipe data
  the test just created (Playwright gives every test a fresh browser context, so the
  DB is still guaranteed fresh at test start).
- **`seedNotes(page, notes)`** — seeds notes into IndexedDB **before** navigation by
  opening the raw `NotesApp` DB at version **40** (Dexie `version(4)` maps to
  IndexedDB version `4 * 10 = 40`) and putting records into the `notes` store. It is
  reload-safe (Round D fix): a `sessionStorage` marker prevents the seed script from
  re-running on `page.reload()`, so seeded notes are never duplicated. Call it before
  `page.goto(APP_PATH)`. Playwright serializes init-script args, so `Date` fields are
  round-tripped back to `Date` inside the page.
- **`step(page, name)`** — takes a full-page screenshot to
  `e2e/artifacts/<spec>/<test>/<name>.png`, logs the path, and returns it. Call it
  after each meaningful UI action to build a visual record of the run. With
  `E2E_NO_SCREENSHOTS=1` it is a fast no-op that returns an empty string.
- **`debugBreak(page, label?)`** — the debug drop-in. When `E2E_DEBUG=1` it logs a
  banner and calls `page.pause()` (Playwright Inspector) so you can interact with the
  app before the assertions run; otherwise it is a fast no-op. Every test calls it once
  at a labeled point after the primary state is established. New tests should import and
  call it the same way.

## Seeding a persistent environment (`scripts/seed-environment.mjs`)

The test runner cannot show you its data afterwards: every test runs in an ephemeral
context and the autouse `freshDb` fixture wipes the `NotesApp` IndexedDB per test. To
browse the app with the suite's seed data, run:

```bash
npm run seed:e2e                 # headed browser, stays open until Ctrl+C
node scripts/seed-environment.mjs --headless   # seed + verify + exit
```

The script borrows the per-spec seed datasets (`makeNote` + `seedNotes` calls), the
in-page seeding routine from `e2e/fixtures.ts`, the SwiftShader launch args from
`playwright.config.ts`, and the app-URL resolution from `e2e/app-path.ts`. It targets
`E2E_BASE_URL`/`E2E_BASE_PATH` like the tests (e.g. attach to the GitHub Pages build),
and writes into a persistent profile at `.seed-profile/` (gitignored) that survives
across runs. Seeded notes use stable ids (9101+), so re-running overwrites the same
rows instead of duplicating; your own notes are never touched. `--reset` starts from
an empty profile, `--url`/`--path`/`--profile` override the defaults, and encrypted or
legacy-schema seeds are intentionally out of scope (they need the app's crypto UI or
an older DB version).

Downloads behave differently under Playwright than in a normal browser: Playwright
intercepts every download and deletes it when the context closes, so nothing ever
reaches `$HOME/Downloads`. The test suite works around this itself —
`export-import.spec.ts` saves each download into `e2e/artifacts/downloads` — and the
seeding script does the same for its browser: every app Export lands in
`.seed-downloads/` by default, or wherever `--downloads` points (e.g.
`--downloads ~/Downloads` for the real folder). Extension handling also differs:
a real browser appends an extension derived from the MIME type when the page's
suggested name has none, while Playwright's interception skips that step — the
seeding script replicates it by sniffing the file content and completing the
extension (`zip`/`json`/`html`/`pem`/`stl` magic bytes).

## Spec inventory

| File | Tests | What it covers |
| --- | --- | --- |
| `app.spec.ts` | 4 | Empty state, create + edit title + persist across reload, edit/view mode toggle, search + tag filter |
| `notes.spec.ts` | 7 | Pin/unpin, delete, tag add/remove, category change + filter, sidebar collapse/expand, switching notes, tag/category facets |
| `editor.spec.ts` | 7 | Slash-command menu, markdown list auto-continuation, callouts, JS code-block execution, mermaid rendering, autosave + reload persistence, GFM tables/task lists |
| `calendar.spec.ts` | 3 | Notes on their edit dates, selecting a note returns to notes mode, reload-safe seeding (no duplicates) |
| `security.spec.ts` | 5 | Password encrypt/lock, wrong-password rejection, correct-password unlock, RSA key-pair encrypt/decrypt, key-pair JWK export |
| `export-import.spec.ts` | 4 | Single-note HTML export, full DB backup (JSON), export-all-as-ZIP, import from file |
| `mobile.spec.ts` | 1 | Mobile top-sheet note list, select → full-screen edit → back |
| `offline.mobile.spec.ts` | 1 | PWA/service-worker offline shell (skipped unless `E2E_PWA=1`, see PWA section) |

**Total: 32 unique specs.** `chromium` (desktop) runs all 32; `chromium-mobile`
(real phone) runs only the two `*mobile*.spec.ts` entries at phone viewport. A
default `npm run test:e2e` therefore runs 34 checks (32 desktop + 2 mobile); the
two offline/PWA runs additionally require `E2E_PWA=1` against `vite preview`.

## Known APP BUGs (flagged in specs with `// APP BUG:`)

1. **Delete has no confirmation dialog.** The Radix `AlertDialog` exists in the UI
   kit but is never wired into the delete flow, so a note is removed immediately with
   no cancel path. Reproduce: hover a note → click Delete → it is gone instantly.
2. **Wrong-password unlock shows no error.** WebCrypto's AES-CBC decrypt failure
   throws an `OperationError` with an **empty** message, and `EncryptionDialog`
   renders its error banner only when `error` is truthy — so a wrong password
   produces no visible error. Reproduce: encrypt a note, unlock with a wrong
   password → no error text appears (the note stays locked).
3. **Freshly generated key pair is not auto-selected.** After generating a key pair,
   `selectedKeyId` stays `''` even though the dropdown visually shows the key, so
   "Encrypt Note" would fail with "Select a key pair". Reproduce: generate a key
   pair, switch to Encrypt, click Encrypt Note without selecting → error. The test
   works around it by selecting the key explicitly.

**Known UX quirk:** unpinning a note bumps `updatedAt` to now, so the note stays at
the top of the list instead of reverting to its original position.

## Documentation screenshots

`e2e/docs-tour.spec.ts` is a **gated** "documentation tour" that drives the app to
its most photogenic, deterministic states and captures PNGs directly into
`docs/images/`, then writes `docs/FEATURES.md` (the committed feature gallery page)
so the images and the page regenerate together atomically.

- **Env gate:** every test starts with
  `test.skip(!process.env.E2E_DOCS || test.info().project.name !== 'chromium', ...)`,
  so the tour only runs when `E2E_DOCS=1` on the `chromium` project. A normal
  `npm run test:e2e` run skips all of these tests and never touches `docs/`.
- **Run it:**
  ```bash
  npm run docs:screenshots
  # equivalent to:
  E2E_DOCS=1 npx playwright test e2e/docs-tour.spec.ts --project=chromium
  ```
- **Linux Docker run:**
  ```bash
  npm run docs:screenshots:docker
  ```
  This uses the pinned Microsoft Playwright image with headless Linux Chromium,
  so generated gallery PNGs do not depend on the host operating system. Docker
  must be running; the app source is mounted back to the host and dependencies
  are kept in a separate Docker volume.
- **Output:** `docs/images/*.png` (stable snake_case filenames) plus
  `docs/FEATURES.md`. Both are committed and regenerate together — commit them as a
  pair. There are no `debugBreak` calls in this spec; it runs unattended.

## Regenerating baselines

Baselines are **platform-independent**: `playwright.config.ts` sets a
`snapshotPathTemplate` that omits the `{-platform}` token (the default template
appends `-darwin`/`-linux`/`-win32`), so the same committed PNG is used on every
OS. `app.spec.ts` runs under the `chromium` project only, so its baselines are
`empty-state-chromium.png` etc. After any `--update-snapshots`, run the spec
again **without** the flag to prove the no-update run passes before committing.
