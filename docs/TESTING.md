# Testing Guide — what you actually need to know

Note Haven is a local-first app: most complexity lives in pure functions
(Markdown/feature parsing), browser APIs (IndexedDB, WebCrypto, WebGL, file
downloads), and rendered UI. The test pyramid mirrors that.

## The three layers (all already wired up)

| Layer | Tool | Where | Command | What it is for |
|---|---|---|---|---|
| Unit | Vitest + jsdom | `src/test/*.test.ts` | `npm test` | Pure logic: Markdown parsing, callouts, feature detection, code-block frontmatter, code runners |
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
- Does it depend on browser-only APIs (IndexedDB, WebCrypto, WebGL, downloads,
  window.open) or cross-component flow? → E2E. That is also the only layer
  that currently exercises the real Dexie/IndexedDB layer.

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

No thresholds are enforced yet. When the suite matures, add e.g.
`coverage.thresholds: { lines: 40 }` to `vitest.config.ts` so CI fails on
regressions rather than absolute numbers.

## Gaps & the tools that fill them (recommended, opt-in)

### Mutation testing — StrykerJS

The one tool worth knowing about that isn't installed. Coverage can't tell you
that an assertion is vacuous; mutation testing can: Stryker flips operators,
removes conditionals and calls, and counts how many mutants your tests kill.

To adopt later:

```bash
npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner
```

with a minimal `stryker.config.json`:

```json
{
  "testRunner": "vitest",
  "coverageAnalysis": "perTest",
  "mutate": ["src/lib/**/*.ts"],
  "reporters": ["html", "clear-text", "progress"]
}
```

Why opt-in: it re-runs the suite per mutant — minutes, not seconds. Use it
targeted (`mutate` on a critical module like `src/lib/encryption*` or
`src/lib/db.ts` parsing) rather than repo-wide, and not in CI by default.

### True integration tests — `fake-indexeddb`

The unit/component layer never touches IndexedDB (E2E does, for real). If you
want store-level tests (Dexie schemas, queries, migrations) in jsdom, add
`fake-indexeddb` and initialize it in `src/test/setup.ts` — then
`import { db } from "@/lib/db"` works in-memory without a browser.

### Network mocking — MSW

Not currently needed: the app is local-first with no backend. Add
[MSW](https://mswjs.io/) only if/when remote backends (see the TODO list) or
URL-based assets start needing deterministic tests.

### Visual regression — already present

Playwright `toHaveScreenshot` baselines, rendered by the devcontainer image.
Refresh with `npx playwright test --update-snapshots` inside the container.

## CI at a glance

| Workflow | What runs | When |
|---|---|---|
| `.github/workflows/ci.yml` | lint, unit+component with coverage, build — Node 22/24/25 | push/PR to main + **Mondays 05:00 UTC (schedule)** |
| `.github/workflows/devcontainer.yml` | the same checks **inside the devcontainer** (+ full E2E on schedule), per-arch image build & publish | push/PR touching devcontainer files + **Mondays 05:30 UTC (schedule)** |
| `.github/workflows/deploy.yml` | build + Pages deploy | push to main |