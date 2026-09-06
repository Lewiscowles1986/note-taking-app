# Why Renovate pipelines are red

This documents *why* CI is red on the open dependency PRs, so the failures can be
triaged by root cause instead of "flaky." It also covers the intermittent test
that makes unrelated PRs go red randomly.

## How CI behaves on a dependency PR

Every PR (opened or re-pushed) triggers three workflows. A single root cause often
shows up as **many** red checks, which makes it look worse than it is:

| Workflow | Trigger path (PR) | Jobs that run | Notes |
|----------|-------------------|---------------|-------|
| `ci.yml` | any PR → `main` | `prepare` + `lint`×3 + `test`×3 + `build`×3 (Node 22/24/25) | `test` runs `vitest --coverage` |
| [`test-quality.yml`](.github/workflows/test-quality.yml) | `opened/synchronize/reopened` | `Coverage & mutation (Node latest)` — `npm run test:coverage` **then** `npx stryker run` | Stryker mutants `src/lib/**`. Header comments call it "report-only — never gates a PR", but it is reported as a check and a failure here still shows as a red/unsuccessful check. This is the slowest job (≈15 min). |
| `devcontainer.yml` | PR paths incl. `package-lock.json`, `.devcontainer/**`, `flake.*` | `build-test (ubuntu-latest, amd64)` + `build-test (ubuntu-24.04-arm, arm64)` | Each builds the base Devcontainer image from source, then runs `npm ci` + the project's real checks **inside the container**. A failing unit test therefore also fails here, twice (once per arch). |

Consequence: one unit-test regression fails `test` (×3), `Coverage & mutation`,
**and** both `build-test` jobs — six-plus checks red from a single source bug.

## Currently red PRs (root causes)

| PR | Bump | Red checks | Root cause | Fix |
|----|------|-----------|------------|-----|
| **#43** | `tailwindcss` → v4 | `test`(×3), `build`(×3), `Coverage & mutation` | Tailwind v4 removed the PostCSS plugin from the `tailwindcss` package. `postcss.config.js` still does `plugins: { tailwindcss: {}, autoprefixer: {} }`, so Vite/PostCSS errors: `[postcss] … install '@tailwindcss/postcss'`. | Install `@tailwindcss/postcss` and reference it in `postcss.config.js`; migrate any v4 CSS-first config (`@import "tailwindcss"`), then re-run CI. |
| **#45** | `typescript` → v7 | ~~`test`/`lint`/`build`~~ `Coverage & mutation` (main) | ~~Lockfile not regenerated~~ **(fixed)**. Lockfile was regenerated and TS7 green across lint/test/build. The remaining red is **Stryker**: its sandbox preprocessor calls `ts.parseConfigFileTextToJson`, removed in TS7's native API (stryker-js#6111, upstream open). | Fix shipped: `test-quality.yml` shadows `typescript` with the JS-based `typescript@npm:@typescript/typescript6@^6.0.2` (`--no-save`) for the Stryker step. Remove that step once stryker-js#6111 ships a fix. |
| **#31** | `lucide-react` ^0.462 → ^0.577 | `test`(×3), `Coverage & mutation`, `build-test`(×2) | Renovate only bumps the package; **the component/test still asserts the old icon CSS class**. `calendarView.test.tsx` (lines ~160/195/331) does `expect(todayCell.querySelector('svg.lucide-file-plus2')).toBeTruthy()`. In 0.577 the generated SVG class for `FilePlus2` changed, so the selector returns `null`. | Update the component/test to not rely on the unstable per-icon `lucide-*` CSS class name (query by `data`/role/`aria-label` instead), or pin to a version whose class names are stable. |
| **#42** | `jsdom` → 30 | `test (24)`, `Coverage & mutation` | Real test regression after the jsdom major bump: `src/test/crypto.test.ts` ("rejects a tampered salt … different derived key") now resolves instead of rejecting — `promise resolved "…" instead of rejecting`. | Investigate the jsdom-30 crypto/`atob`/`crypto` behavior change and update the test expectations (or isolate webcrypto usage). |
| **#16** | `@playwright/test` → 1.63.0 | `build-test (amd64)`, `build-test (arm64)` | The repo's own guard in `.devcontainer/post-create.sh` fails the container setup on a version mismatch: `npm lockfile: @playwright/test 1.63.0` vs `devcontainer image: mcr.microsoft.com/playwright:v1.58.2-noble`. `.devcontainer/base.Dockerfile` still pins `v1.58.2-noble`. | Bump `ARG PLAYWRIGHT_IMAGE` in `.devcontainer/base.Dockerfile` to a `1.63.x`-series image so the baked browsers match the locked `@playwright/test`. |

## The unrelated flaky test (`noteViewer.test.tsx`)

`src/test/noteViewer.test.tsx` — **"special block dispatch › renders mermaid fences
through MermaidBlock"** fails intermittently:

```
TypeError: Cannot read properties of undefined (reading '1')
  ❯ src/test/noteViewer.test.tsx:650:38   expect(renderMock.mock.calls[0][1]).toBe('graph TD\n  A --> B')
```

`renderMock` is not called on some runs (a race between the mocked `mermaid`
`initialize` and `render`), most often on the **arm64** devcontainer job. It is
**unrelated to every dependency bump above**, and it passed on the other archs on
the same run. Because the Devcontainer arm64 `build-test` runs the same suite, this
flake turns otherwise-green dependency PRs red randomly — which is one reason a PR
can be red in one run and green in the next (e.g. #25, #32 were merged only after a
re-run went green).

**Recommendation:** stabilize it — assert on the awaited render output rather than a
`mock.calls[0][1]` race, or `await` the mocked promise before asserting. Until then,
re-run the arm64 `build-test` once before trusting a red it causes.
