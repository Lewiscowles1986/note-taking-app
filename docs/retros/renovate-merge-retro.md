# Retro: merging the Renovate PR batch

A candid review of how this run went — the initial input, the path taken, what
worked, what didn't, and what to change next time. Companion docs:
[`failing-pipelines.md`](failing-pipelines.md),
[`renovate-compute-strategy.md`](renovate-compute-strategy.md),
[`renovate-cost-saving-pr.md`](renovate-cost-saving-pr.md).

## The initial input (as given)

> "Get us up to date with the latest `main`, because now renovate is running in the
> pipelines. Using a /subagent per commit, checkout the PR branch; merge the PR if
> it is in a good (passing state)."

That's a reasonable brief, but it left several things ambiguous that mattered a
lot in practice (see "Prompt modifications" below).

## The path taken

1. **Assessed** the repo and listed the open PRs — 32 Renovate PRs, all based on
   the same `main`, all with CI still churning.
2. **Spawned one subagent per PR** (32 in parallel). Each was told to: fetch the
   branch into its own git worktree, wait on `gh pr checks --watch`, and merge via
   `--merge` only if every check was green and the PR was `MERGEABLE`.
3. **Hit the real-world noise**:
   - a **flaky mermaid test** (`noteViewer.test.tsx`) intermittently failed the
     arm64 Devcontainer job, reddening otherwise-fine PRs;
   - **Renovate force-rebased** every open branch each time `main` advanced, so
     heads kept moving and CI kept restarting;
   - merging PRs in a loop made the remaining branches conflict/rebase, re-triggering
     their CI (near-quadratic cost).
4. **Collected results**: 24 of the original 32 merged; 8 not merged (flaky-test
   reds, conflicts, or genuine failures). Two new PRs (#44, #45) appeared mid-run
   and were handled.
5. **Reconciliation pass**: re-verified the 10 still-open PRs on their stabilized
   heads, merged the genuinely-green ones (#7, #25, #29, #32, #44), and confirmed
   the 5 with **genuine** failures (#16, #31, #42, #43, #45) must stay open.
6. **Final state**: 29 merged, 5 open with real failures requiring code/config
   work. Local `main` fast-forwarded to the tip.
7. **Documented** the failures and the compute-cost strategy.

## What worked

- **Subagent-per-PR parallelism** got through 29 merges in one session.
- **Worktree isolation** (one worktree per PR) kept the main working tree clean
  throughout.
- **The reconciliation pass** was the most valuable step: it separated the
  flaky-test false negatives (re-ran green → merged) from the genuine failures
  (correctly left open). Without it, several mergeable PRs would have been left
  behind and several broken ones might have been force-merged.
- **Strict "all checks green" gate** correctly refused to merge the 5 genuinely
  broken PRs.

## What didn't work (and why)

- **The `rm -rf .wt` cleanup instruction was a mistake.** My prompt told subagents
  to "remove the leftover `.wt` dir", and several interpreted that as deleting the
  whole shared worktree directory — nuking sibling subagents' checkouts mid-run.
  They restored them, and no commits were lost (git objects live in the shared
  `.git`), but it was destructive churn and could have lost uncommitted work.
- **32 concurrent subagents = a CI stampede.** Every PR ran the full stack at
  once, saturated runners, queued jobs, and — because each merge force-rebased the
  rest — caused a near-quadratic re-run cascade. This is the single biggest cost
  and time sink.
- **`gh pr checks --watch` per subagent** held a job open ~15 min each and made the
  run serial-ish on the slowest check; many subagents just sat waiting.
- **The flaky mermaid test** made the "all green" gate noisy: some PRs merged by
  luck, others needed a re-run. It also caused several false "not merged" results
  that the reconciliation pass had to undo.
- **Renovate force-rebasing** meant heads moved under the subagents; each had to
  re-sync and re-wait, and CI runs were invalidated repeatedly.
- **Late/duplicate subagent reports** (the runtime re-delivered finished results)
  added noise but no harm.

## Prompt modifications for next time

If you run this again, tighten the brief:

1. **Define "good (passing state)" explicitly.** e.g. *"Merge only if every check
   is SUCCESS (SKIPPED is fine). A failure of the known-flaky
   `noteViewer.test.tsx` mermaid test on the arm64 Devcontainer job does NOT count
   — re-run that check once; if it passes, the PR is good. Any other failure is a
   genuine blocker."*
2. **Specify the merge strategy** (merge commit vs squash) and **conflict policy**
   (rebase onto latest `main` and push, or leave for Renovate).
3. **Specify whether to fix failing PRs or just report.** This run only merged
   passing PRs and reported the 5 broken ones. If you want them fixed too, say so.
4. **Cap concurrency.** Instead of "one subagent per PR", say *"process at most
   5–8 PRs at a time; wait for those to settle before starting the next batch."*
   This avoids the stampede and the rebase dominoes.
5. **Forbid destructive shared cleanup.** *"Never delete or `rm -rf` the shared
   `.wt` directory or any worktree you did not create. Remove only your own
   worktree."*
6. **Prefer not to watch CI at all.** *"Do not run `gh pr checks --watch`. Read the
   PR's current status checks once; if green and `MERGEABLE`, merge; if not, report
   and move on."* (Or rely on Renovate automerge — see below.)
7. **State the end condition.** *"When all PRs are either merged or reported as
   genuinely failing, stop and summarize."*

## Recommendations for future re-runs

**Do the cheap thing first — make Renovate stop producing 30 PRs.** Apply
[`renovate-cost-saving-pr.md`](renovate-cost-saving-pr.md): group npm updates,
cap concurrency, schedule off-peak, and automerge green patch/minor PRs. Then a
"merge the Renovate batch" run is a handful of PRs, not 30.

- **Stabilise the flaky mermaid test** (or explicitly exclude it from the gate)
  before trusting CI greenness — it caused most of the false negatives.
- **Prefer Renovate automerge** for patch/minor/lockfile-only updates so there is
  no manual watch-and-merge loop at all. Reserve human/subagent attention for
  majors and genuine failures.
- **Batch, don't stampede.** If you must hand-merge, do 5–8 at a time and let CI
  settle between batches.
- **Triage genuine failures by root cause**, not by re-running. The 5 open PRs
  (#16, #31, #42, #43, #45) each have a specific, documented fix in
  `failing-pipelines.md`; re-running them won't help.
- **Use a merge queue** if you keep hand-merging, so remaining green PRs
  auto-rebase instead of being force-rebased by Renovate.
- **Clean up worktrees at the end** and fast-forward local `main` (done this run).

## Bottom line

The approach (subagent-per-PR + strict green gate + reconciliation) was sound and
landed 29 merges with the 5 genuinely-broken PRs correctly left open. The pain
came from **volume** (30+ concurrent PRs and subagents) and **noise** (the flaky
test + Renovate force-rebasing). Both are fixable upstream — by grouping/throttling
Renovate and stabilising the flaky test — rather than by working harder in the
merge loop.
