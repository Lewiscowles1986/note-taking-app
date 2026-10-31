# Plan: Fix Renovate GitHub Action write access

## Context
- Run `41175453275` completes with exit code 6 and logs:
  - `POST …/statuses/<sha>` returns `403 Forbidden`
  - body `Resource not accessible by personal access token`
  - response header `x-accepted-github-permissions: statuses=write`
- The workflow also lacks an explicit `permissions` block, so it relies on the repo's default workflow permissions, which is `read`.
- Triggers include `push: branches: [main]`, so every merge to `main` fires Renovate unnecessarily.

## Goal
1. Stop running Renovate on every push/merge to `main`.
2. Keep scheduled and manual (`workflow_dispatch`) triggers only.
3. Grant the smallest set of workflow permissions that allow Renovate to create/update branches, PRs, statuses, and workflow-file updates.
4. Iterate with real manual workflow runs until the run exits successfully without permission errors.

## Hypothesised permission set
Workflow-level:
- `contents: write`
- `pull-requests: write`
- `issues: write`
- `statuses: write`
- `workflows: write`

These correspond to Renovate's GitHub platform needs:
- contents: branches/commits
- pull-requests: create/update PRs
- issues: optional issue/lockfile maintenance
- statuses: branch stability commit statuses (`renovate/stability-days`)
- workflows: ability to update `.github/workflows/*` in PRs

## Execution loop
1. Edit `.github/workflows/renovate.yml`.
2. Commit and push the feature branch.
3. Trigger manually:
   `gh workflow run renovate.yml --ref fix/renovate-permissions`
4. Poll until completion and inspect logs for 403/permission errors.
5. Narrow or widen the permission set based on observed errors.
6. Repeat until conclusion `success` and no permission-denied messages.