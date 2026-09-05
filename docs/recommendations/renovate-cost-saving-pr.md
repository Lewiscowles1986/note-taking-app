# Renovate cost-saving PR — description & change plan

> Use this as the PR body / change plan for the work that cuts the compute cost of
> Renovate's dependency-update pipeline. It pairs with
> [`docs/renovate-compute-strategy.md`](renovate-compute-strategy.md) (the full
> analysis) and [`docs/failing-pipelines.md`](failing-pipelines.md) (why the
> remaining PRs are red).

## Summary

Renovate currently opens **one PR per dependency, with unlimited concurrency, at
any time of day**, and every PR runs the full CI stack (a 3-Node `ci` matrix, the
Stryker mutation job, and two Devcontainer image builds). Merging ~30 PRs in a
loop force-rebases every still-open branch, re-triggering all of their CI — so the
cost is roughly **quadratic** in the number of PRs and lands in the hundreds of
Actions minutes.

This PR makes three changes that cut that cost by an order of magnitude:

1. **Group** most npm updates into a few PRs instead of one per dependency.
2. **Throttle** concurrency and schedule the burst off-peak.
3. **Automerge** green patch/minor PRs so nobody has to watch-and-merge each one.

It also trims the most redundant CI work per PR.

## Changes

### 1. `renovate.json` — group, throttle, schedule, automerge

```jsonc
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "enabled": true,
  "prCreation": "immediate",
  "extends": ["config:recommended"],

  // Throttle: stop the unlimited stampede (was 0 = unlimited).
  "prConcurrentLimit": 6,
  "prHourlyLimit": 4,
  "branchConcurrentLimit": 6,

  // Run the burst off-peak instead of "at any time".
  "schedule": ["* * 5,6 * *"],   // weekends only — adjust to your off-peak

  // Automerge green patch/minor updates; keep majors as reviewable PRs.
  "automerge": true,
  "automergeType": "branch",
  "platformAutomerge": true,
  "separateMajorMinor": true,

  "packageRules": [
    // All patch & minor npm deps -> ONE PR.
    {
      "matchDatasources": ["npm"],
      "matchUpdateTypes": ["minor", "patch"],
      "groupName": "npm-all-minor-patch",
      "automerge": true,
      "automergeStrategy": "squash"
    },
    // All lockfile-only npm updates -> ONE PR.
    {
      "matchManagers": ["npm"],
      "matchFileNames": ["package-lock.json"],
      "groupName": "npm-lockfile-updates",
      "automerge": true,
      "automergeStrategy": "squash"
    },
    // Keep the existing github-actions rule.
    { "matchManagers": ["github-actions"], "enabled": true, "prCreation": "immediate" }
  ],

  "customManagers": [ /* unchanged — node-version regex managers */ ]
}
```

**Effect:** the long tail of patch bumps collapses from ~25 PRs to 2–3 grouped
PRs; majors (e.g. tailwind v4, typescript v7) stay separate and reviewable; green
patch/minor PRs auto-merge without a human or subagent polling `gh pr checks`.

### 2. `.github/workflows/ci.yml` — drop redundant matrix work

- Run `lint` on **one** Node version (it is version-agnostic) instead of three.
- Run `test` with plain `npm run test` in the matrix; coverage is already owned by
  `test-quality.yml`.
- Keep `build` but run it once (Node 22) — `vitest` already transpiles/type-checks,
  so the 3× build matrix mostly repeats `test`.

Net: the 10-job matrix drops to ~5 jobs per PR.

### 3. `.github/workflows/test-quality.yml` — take Stryker off the per-PR path

The header already calls this job **"report-only — it never gates a PR"**, yet it
runs on every `pull_request` and is the slowest job (~15 min). Move it to a weekly
schedule + `main` pushes so it stops reddening/blocking every dependency PR and
stops doubling per-PR cost:

```yaml
on:
  schedule: [{ cron: "0 6 * * 1" }]   # weekly (Mon 06:00 UTC)
  push: { branches: [main] }
  workflow_dispatch:
```

### 4. `.github/workflows/devcontainer.yml` — don't rebuild the image per dependency bump

The Devcontainer workflow triggers on PR paths including `package-lock.json`, so
every Renovate lockfile PR builds the base Docker image from source on **both**
architectures. For dependency-only PRs the image itself doesn't change. Narrow the
`pull_request` trigger to the files that actually affect the image:

```yaml
on:
  pull_request:
    paths:
      - ".devcontainer/**"
      - "flake.nix"
      - "flake.lock"
      - ".dockerignore"
      - "scripts/build-devcontainer-base.sh"
      - ".github/workflows/devcontainer.yml"
```

(Keep `package-lock.json` out of the PR trigger; the image only changes when the
pinned Playwright/base version changes, which is a deliberate, separate change —
see failing PR #16.)

### 5. `.github/workflows/ci.yml` — cache `node_modules` across the matrix

Each matrix job runs a fresh `npm ci`. Add an application-level cache so installs
that do land are fast and lockfile churn doesn't re-download a fresh tree:

```yaml
- uses: actions/cache@v4
  with:
    path: node_modules
    key: node_modules-${{ hashFiles('package-lock.json') }}
```

## Expected impact

| Metric | Before | After |
|--------|--------|-------|
| Open Renovate PRs per cycle | ~30 | ~3–6 |
| CI runs per cycle | ~30 × full stack | ~3–6 × trimmed stack |
| Per-PR Actions minutes | ~100–160 | ~40–60 |
| Manual watch-and-merge time | ~300 min (serial) | ~0 (automerge) |
| Rebase/CI re-trigger churn | near-quadratic | ~linear |

## Risks & rollback

- **Grouping** can hide a breaking patch inside a green group. Mitigated by
  `separateMajorMinor` (majors stay separate) and by keeping `automerge` limited to
  `patch`/`minor` + lockfile-only groups.
- **Automerge** merges without human review. If you want a safety net, keep
  `platformAutomerge` but require the existing CI checks to pass (they already do —
  branch protection is not currently enabled, so consider enabling it for `main`).
- **Rollback:** every change is a small, reversible config edit. Revert
  `renovate.json` to `prConcurrentLimit: 0` / `schedule: "at any time"` and restore
  the workflow triggers to return to today's behaviour.

## Testing

- Run `renovate-config-validator` (already a step in `.github/workflows/renovate.yml`)
  to validate the new `renovate.json`.
- Merge this PR, then watch the next Renovate cycle: confirm grouped PRs appear,
  concurrency is capped, and green patch/minor PRs auto-merge.
- Confirm `ci.yml` still catches real regressions (the `test` matrix + coverage job
  remain) and that the Devcontainer image is still validated on the weekly schedule
  and on `main`.

## Out of scope (separate PRs)

- Fixing the 5 currently-red PRs (#16, #31, #42, #43, #45) — see
  `docs/failing-pipelines.md`.
- Stabilising the flaky `noteViewer.test.tsx` mermaid test.
- Enabling branch protection on `main`.
