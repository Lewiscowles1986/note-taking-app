# Strategy: cutting the compute cost of merging many Renovate PRs

## The problem

The repo is configured for **volume without throttle**:

- [`renovate.json`](../renovate.json) sets `prConcurrentLimit: 0` and
  `branchConcurrentLimit: 0` — both **unlimited**. Renovate opened 32 PRs in one
  hour, and every dependency is its own PR (no grouping).
- `schedule: ["at any time"]` — the stampede can land in the middle of the day.
- `prCreation: "immediate"` — branches/PRs are pushed the moment a new version is
  detected, so CI storms are frequent.

Each PR then runs the full CI stack (see `docs/failing-pipelines.md`):

| Cost centre | What runs | Per-PR Actions minutes (est.) |
|-------------|-----------|-------------------------------|
| `ci.yml` matrix | `prepare` + `lint`/`test`/`build` × Node 22/24/25 (9 jobs, each `npm ci`) | ~50–70 job-min |
| `test-quality.yml` | `test:coverage` + Stryker mutation (`src/lib`, concurrency 4) | ~15–20 job-min (slowest job) |
| `devcontainer.yml` | 2 × (`base.Dockerfile` build + real checks in container) | ~40–80 job-min |
| **Total** | | **~100–160 job-min per PR** |

**The multiplier is the real problem**: `N` PRs that arrive together, and every
merge force-rebases all the still-open Renovate branches, which **re-triggers their
entire CI**. Merging ~30 PRs in a loop re-runs each remaining PR's full CI roughly
once per merge → roughly quadratic cost in the number of PRs, plus the wall-clock
serial merge time (~10 min of watching per PR, ~300 min total).

So the goal is threefold: **(a)** fewer PRs, **(b)** less CI per PR, and **(c)** less
re-triggering when merging.

## 1. Fewer PRs — group dependencies (biggest win)

Collapse most updates into a handful of PRs. In `renovate.json` add `groupName`
rules (and drop the per-dependency default):

```jsonc
{
  // Patch & minor npm deps -> ONE PR
  "packageRules": [
    {
      "matchDatasources": ["npm"],
      "matchUpdateTypes": ["minor", "patch"],
      "groupName": "npm-all-minor-patch"
    },
    // All lockfile-only updates -> ONE PR
    { "matchManagers": ["npm"], "matchFileNames": ["package-lock.json"],
      "groupName": "npm-lockfile-updates" }
  ]
}
```

Then major upgrades and the handful that genuinely need code changes (e.g.
tailwind v4, typescript v7) stay as their own PRs, but the long tail of patch bumps
goes from ~25 PRs → 2–3 PRs → **~5–10× fewer CI runs**.

## 2. Throttle concurrency so Renovate cannot stampede

`0` means unlimited — replace with a sane non-zero cap and a calmer cadence:

```jsonc
{
  "prConcurrentLimit": 6,
  "prHourlyLimit": 4,
  "branchConcurrentLimit": 6,
  "schedule": ["* * 5,6 * *"]   // weekends only (or your off-peak)
}
```

Capping concurrently-open branches/PRs means far fewer PRs have their CI running at
once, runners stop queuing, and there is less chance of a merge force-rebasing a
long tail of siblings.

## 3. Automate the merge — stop watching every PR

The ~10 min/PR "watch then merge" loop is manual overhead (and what I did with a
subagent per PR). Let CI do the gating:

```jsonc
{
  "separateMajorMinor": true,
  "automerge": true,
  "automergeType": "branch",
  "platformAutomerge": true,
  "packageRules": [
    { "matchUpdateTypes": ["patch", "minor"],
      "automerge": true, "automergeStrategy": "squash" }
  ]
}
```

Green patch/minor PRs then auto-merge and auto-delete their branches on their own.
With `platformAutomerge` GitHub merges as soon as status checks pass; no human or
subagent needs to poll `gh pr checks --watch`. This eliminates almost all the
serial 300 minutes.

## 4. Less CI per PR

The workflows currently spend a lot of Actions minutes telling us the same thing
twice. Consider:

- **Build job is mostly redundant with `test`** — `vitest` already transpiles and
  type-checks. Keep `build` but run it once (Node 22) or fold it into `test`.
  Removes up to 1/3 of the `ci.yml` matrix.
- **`lint` is version-agnostic** — run it on one Node version, not three. Saves 2
  lint jobs per PR.
- **`test` doesn't need per-Node coverage** — `npm run test:coverage` is already run
  by `test-quality.yml`. Use plain `npm run test` in the matrix and let
  `test-quality` own coverage+mutation.
- **Stryker mutation is the slowest and is explicitly "report-only"** (never gates
  a PR, per its own header). Consider running it only on `main`/on a weekly
  schedule instead of on every PR, so it stops blocking/reddening each dependency
  PR and stops doubling the per-PR cost.

```yaml
# test-quality.yml
on:
  schedule: [{ cron: "0 6 * * 1" }]   # weekly; drop the pull_request trigger
  push: { branches: [main] }
```

- **`devcontainer.yml` builds a Docker base image from source on every
  lockfile-touching PR** (its `on.pull_request.paths` includes `package-lock.json`).
  For dependency-only PRs the Devcontainer image itself usually doesn't change, so
  each is a wasted Docker build. Narrow the trigger to the files that actually
  affect the image (`.devcontainer/**`, `flake.*`, `.dockerignore`,
  `scripts/build-devcontainer-base.sh`) and/or make a change to the base image a
  separate PR that also bumps the pinned Playwright version (see failing PR #16).

## 5. Make `npm ci` cheaper in the matrix

Each of the ~9 matrix jobs runs a fresh `npm ci`. It already uses
`actions/setup-node` `cache: npm`. If lockfiles change constantly, add an
application-level cache:

```yaml
- uses: actions/cache@v4
  with:
    path: node_modules
    key: node_modules-${{ hashFiles('package-lock.json') }}
```

so installs that do land are much faster and the heavy `package-lock.json` churn
doesn't re-download a fresh tree every time.

## 6. Reduce re-trigger churn when merging

The serial merge loop caused every remaining Renovate branch to be force-rebased,
restarting its CI each time (this is what made the wall-clock cost balloon). Steps
1–3 mostly fix this (fewer PRs + automerge → no manual serial loop). For the
residual manual merges:

- Merge in **dependency-order batches** (one Renovate group per merge, not one
  `package-lock.json` line at a time) so few branches move per merge.
- Enable GitHub **merge queue** for auto-rebase of remaining green PRs if you must
  hand-merge.
- Keep `prCreation: "immediate"` off during big rebase periods, or run at the hours
  you want the CI burst.

## Bottom line

Ordered by impact:

1. **Group npm updates** → ~5–10× fewer PRs/CI runs.
2. **Automerge patch/minor green PRs** → removes the manual watch-and-merge loop
   (the ~300 wall-clock minutes).
3. **Cap `prConcurrentLimit`/`prHourlyLimit` + schedule off-peak** → no stampede /
   queued runners / rebase dominoes.
4. **Trim redundant CI** (single-node lint, non-covering matrix `test`, Stryker off
   the per-PR path, Devcontainer not rebuilt per dependency bump).
5. **Cache `node_modules`** across the matrix.

Apply 1+2 first — together they cut both the number of Actions minutes and the
human merge time by an order of magnitude.
