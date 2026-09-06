# Testing Guide — what you actually need to know

Note Haven is a local-first app: most complexity lives in pure functions
(Markdown/feature parsing), browser APIs (IndexedDB, WebCrypto, WebGL, file
downloads), and rendered UI. The test pyramid mirrors that.

**Current state (after the test-quality campaign):** 32 test files / 447
tests, all green, ~7.5s wall for `npm test`. Line coverage is **99.77%**
(4362/4372 executable lines; 99.59% functions, 96.56% branch) with 100% lines
on 27 of the 30 measured files — the three exceptions are owner-accepted dead
code (see [below](#the-three-dead-fragments--the-path-to-literal-100)).
Mutation score on `src/lib` is **86.87%** against a >50% target.

## The three layers (all already wired up)

| Layer | Tool | Where | Command | What it is for |
|---|---|---|---|---|
| Unit | Vitest + jsdom | `src/test/*.test.ts` | `npm test` | Pure logic: Markdown parsing, callouts, feature detection, code-block frontmatter, code runners, crypto, db, export/import |
| Component | Vitest + React Testing Library (`@testing-library/react` + `jest-dom`) | `src/test/*.test.tsx` | `npm test` | Rendered components & user interactions in a fake DOM |
| E2E | Playwright (Chromium, real IndexedDB) | `e2e/*.spec.ts` | `npm run test:e2e` | Whole app in a real browser: note CRUD, editor, calendar, encryption, export/import, 3D/GeoJSON rendering. Details: [e2e/README.md](../e2e/README.md) |

All three run identically inside the dev container (which is also the
canonical renderer for E2E visual baselines — see
[.devcontainer/README.md](../.devcontainer/README.md)).

**Choosing a layer** — rule of thumb:

- Can you test it by calling a function and asserting its return value? → unit.
- Do you need to render a component and click/type into it? → component
  (same file layout as unit tests; `@testing-library/jest-dom` matchers are
  loaded in `src/test/setup.ts`).
- Does it depend on genuinely browser-only APIs (WebGL, file downloads,
  window.open) or cross-component flow? → E2E. IndexedDB and WebCrypto now
  also work in jsdom (via `fake-indexeddb` and Node's webcrypto — see
  below), so only WebGL/real-browser behavior and whole-app flows *require*
  E2E.

## Code coverage (`npm run test:coverage`)

Vitest's V8 coverage provider (`@vitest/coverage-v8`) — no instrumentation
build step, so it costs seconds.

- Reporters: `text` (table in the terminal/CI log), `html` (open `coverage/index.html`), `lcov` (`coverage/lcov.info` for tooling).
- CI runs coverage instead of plain tests: `ci.yml` → `npm run test:coverage`;
  the scheduled devcontainer job does the same inside the container.
- Scope: `src/**` minus `src/test/**`, `src/main.tsx`, `.d.ts` and the
  vendored `src/components/ui/**` shadcn plumbing (see `vitest.config.ts`).
- Coverage measures *execution*, not assertion quality — which is why the
  mutation-testing option below exists.

Current standing: **99.77% lines (4362/4372), 99.59% functions, 96.56%
branch**. Every file is at 100% lines except the three accepted dead-code
fragments below — keep it that way when adding code.

No thresholds are enforced yet, but the suite now has the headroom for very
high ones: add e.g. `coverage.thresholds: { lines: 99, functions: 99 }` to
`vitest.config.ts` so CI fails on regressions rather than absolute numbers.

## The three dead fragments & the path to literal 100%

Exactly three fragments (~12 lines) never execute; they are the only reason
coverage sits at 99.77% instead of 100.00%. Each is provably dead, the owner
has accepted them for now, and app code was deliberately left untouched:

| File | Lines | Fragment | Why it is dead |
|---|---|---|---|
| `src/lib/import.ts` | 38–43 | module-private `extractTitle()` | Zero call sites repo-wide — callers derive titles inline. |
| `src/components/Model3DBlock.tsx` | 644–646 | `else { model = new THREE.Object3D() }` fallback (keep the `if`) | Unreachable: React batches `setLoading(true)` with every model-type change, so the loader never unmounts into this arm. |
| `src/components/NoteEditor.tsx` | 123 | the `: 'Untitled'` ternary arm (keep the truthy arm) | The inserted markdown attachment line always matches `find(l => l.trim())`, so `firstLine` is always truthy. |

Options, if the owner ever wants a literal 100.00%:

- **Option A — leave as is (current choice).** Strictest no-touch policy:
  99.77% stands, the fragments are documented here for future cleanup. Zero
  regression risk.
- **Option B — delete the dead code.** Remove `extractTitle()`, the
  `Object3D` else-arm, and the `'Untitled'` ternary arm — ~12 lines across 3
  files, zero behavior change (each fragment is provably unreachable), with
  the full suite + E2E as the regression net. Yields a literal 100.00%.
- **Option C — ignore-hint comments.** Add `/* v8 ignore next */` at the
  three sites. App files are touched but no logic changes; coverage reports
  100%.

## Gaps & the tools that fill them

### Mutation testing — StrykerJS (installed)

Coverage can't tell you that an assertion is vacuous; mutation testing can:
Stryker flips operators, removes conditionals and calls, and counts how many
mutants your tests kill. It is installed (`@stryker-mutator/core` +
`@stryker-mutator/vitest-runner`) and configured in `stryker.config.json`:

```bash
npx stryker run   # ~10 min in-container at concurrency 4; not for CI by default
```

- Scope: `src/lib/**/*.ts`, `coverageAnalysis: "perTest"`. Baseline run
  (937 mutants): **86.87% total score, 89.45% on covered code** — 813 killed,
  96 survived, 1 timeout, 27 no-coverage. Target was >50%; met at baseline.
- HTML report: `reports/mutation/mutation.html` (gitignored).

Per-module scores from that run:

| Module | Score | Module | Score |
|---|---|---|---|
| `callouts.ts` | 100 | `export.ts` | 86.96 |
| `codeRunners.ts` | 100 | `codeBlockFrontmatter.ts` | 83.33 |
| `utils.ts` | 100 | `import.ts` | 80.95 |
| `db.ts` | 95.24 | `jsRunner.ts` | 77.22 |
| `crypto.ts` | 94.38 | | |
| `imageProcessor.ts` | 93.10 | | |

Two config settings are load-bearing:

- `vitest.related: false` — Stryker's related-tests default only ran 349 of
  the 447 tests and would gut the score.
- `ignorePatterns` (`.seed-profile`, `.npm-cache`, `coverage`, `dist`, …) —
  keeps seed symlinks, caches and build output out of Stryker's sandbox copy.

Use it targeted: point `mutate` at a single module when hunting survivors in
it, and keep it out of CI by default.

### True integration tests — `fake-indexeddb` (installed)

`fake-indexeddb/auto` is initialized in `src/test/setup.ts`, together with
the polyfills jsdom 20 lacks: Node's webcrypto, `TextEncoder`/`TextDecoder`,
`Blob.prototype.text` (File.text inherits it), `navigator.clipboard`, a
`ResizeObserver` stub and a `matchMedia` stub. Each polyfill only defines
what is missing, so nothing is clobbered on jsdom upgrades.

That unlocked in-jsdom store-level tests (`db.test.ts`: Dexie schema, queries,
migrations), hooks tested against the real db module (`use-notes`,
`use-encryption`, `use-toast`), and crypto/export/import round-trips without a
browser. E2E remains the layer for WebGL, downloads and real-browser flows.
(Upgrading jsdom to ≥21 would make `Blob.text`/`File.text` native and let
those polyfills be removed.)

### Network mocking — MSW

Not currently needed: the app is local-first with no backend. Add
[MSW](https://mswjs.io/) only if/when remote backends (see the TODO list) or
URL-based assets start needing deterministic tests.

### Visual regression — already present

Playwright `toHaveScreenshot` baselines, rendered by the devcontainer image.
Refresh with `npx playwright test --update-snapshots` inside the container.

## Known noise (harmless; clean-up candidates)

- `Model3DBlock` tests log React `act()` warnings.
- React Router v7 future-flag warnings appear in every jsdom run.

## CI at a glance

| Workflow | What runs | When |
|---|---|---|
| `.github/workflows/ci.yml` | lint, unit+component with coverage, build — Node 22/24/25 | push/PR to main + **Mondays 05:00 UTC (schedule)** |
| `.github/workflows/devcontainer.yml` | the same checks **inside the devcontainer** (+ full E2E on schedule), per-arch image build & publish | push/PR touching devcontainer files + **Mondays 05:30 UTC (schedule)** |
| `.github/workflows/github-pages.yml` | build + publish `main` to the `gh-pages` root (keeps `preview-builds/`), **and** publish each PR's branch as a live badged preview under `preview-builds/<branch>/` (isolated storage) | push to main + every PR to main (via `peaceiris/actions-gh-pages`) |