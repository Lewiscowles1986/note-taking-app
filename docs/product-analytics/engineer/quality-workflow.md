---
audience: engineer
diataxis: explanation
reading-time: ~3 min
staged-files:
  - .github/workflows/test-quality.yml
  - .github/stryker-shards.json
  - src/lib/posthog.ts
last-reviewed: 2026-10-08
---

# Analytics code and the Test Quality workflow

This is a CI explanation, not an analytics how-to. It covers how the
[Test Quality workflow](../../../.github/workflows/test-quality.yml) touches
the analytics code staged for commit, and what a change to `src/lib/posthog*`
implies there. The workflow is scheduled (Mondays 06:00 UTC) and
manual-dispatch only — it never runs on pushes or pull requests and does not
gate them.

## How the workflow relates to analytics code

The mutation job runs Stryker over disjoint subsets of `src/lib`; the
subsets are listed in [.github/stryker-shards.json](../../../.github/stryker-shards.json).
Shard 2 currently includes `src/lib/oidcAuth.ts` — the identification code —
so its mutants are exercised in that shard.

`src/lib/posthog.ts` and `src/lib/posthogLogs.ts` are **not** in any shard.
Consequences:

- These files get no mutation score; surviving mutants there are invisible.
- Their behaviour is still exercised indirectly: shard dry runs execute the
  whole test suite, and any test importing a component that calls
  `posthog.capture` runs the real module.

When you assume the workflow covers a change to the two unmutated files,
check the shards first.

## What to do when you change analytics code

- **Changed `src/lib/oidcAuth.ts`** — mutation results for it appear in the
  shard 2 report after the next scheduled or manual run. Nothing to wire up.
- **Changed `src/lib/posthog.ts` or `src/lib/posthogLogs.ts` and want them
  mutated** — edit `.github/stryker-shards.json` so a shard's `--mutate`
  glob includes the file. Each shard pays its own full-suite dry run, so
  prefer adding a file to an existing similar shard over creating a new one.
  The merge step (`scripts/merge-mutation-reports.mjs`) combines shard
  reports, so no other workflow change is needed.
- **Added unit tests importing analytics code** — they run in every shard's
  dry run and in the `report` job's `npm run test:coverage`. If the tests
  make network calls to the analytics host, they belong behind the normal
  test mocks so shards don't emit real traffic.

## Reporting thresholds and analytics code

The report (`scripts/test-quality-report.mjs`) summarises per-file scores
from the merged `mutation.json`. A file absent from the shards simply has no
section in the report — absence is not a failure. If you add the posthog
files to a shard and their score drops because the SDK's own code paths resist
mutation (many guards against real network activity), that is expected; judge
the score against the report before editing the shard again.