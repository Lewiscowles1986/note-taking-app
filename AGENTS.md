# AGENTS.md — working in this repository

Guidance for coding agents / assistants. Read this before making changes.

## Working tree discipline: never commit to `main` directly

`main` is the integration branch. All work happens in a dedicated branch, held
in its own **git worktree** under `.worktrees/<name>` (see the existing
`.worktrees/` directories for the pattern). Keep worktrees and branches named
after the concern they own.

- Create a new worktree + branch for each independent piece of work:
  `git worktree add .worktrees/<name> -b <branch>`
  (branch naming convention is already used in the repo: `feat/…`, `fix/…`,
  `ci/…`, or a plain short name).
- Do work, commit to that branch, and push it to origin for a PR. Do **not**
  commit to `main` and do **not** run work directly from the main worktree.
- The main checkout at the repo root is for reading, running the full test
  suites, and acting as the base your worktrees branch from — not for committing
  feature work.
- A worktree can be added/removed freely; the branch holds the work. When a PR
  merges, the worktree can be pruned and the branch deleted.

### Devcontainer work in particular

Anything touching the dev container — `.devcontainer/**`,
`flake.nix` / `flake.lock`, the toolchain the image bakes in, the
`Devcontainer` workflow (`.github/workflows/devcontainer.yml`), or the
`scripts/build-devcontainer-base.sh` / `scripts/devcontainer-up.sh` / e2e
helpers — **must be its own branch in its own worktree** (e.g.
`.worktrees/<name>` on a `fix/devcontainer-…` or `feat/devcontainer-…` branch).
This is required because:

- The `Devcontainer` workflow rebuilds and republishes the shared multi-arch
  base image; any mistake in that branch affects every contributor's container,
  so it goes through review on a PR like everything else.
- The image version is derived from `.devcontainer/base.Dockerfile` and consumed
  by `devcontainer.json` and `scripts/e2e-docker.sh` — those must change
  together and be validated together (see `.devcontainer/README.md` and the
  pairing check in `.devcontainer/post-create.sh`).

## Validating devcontainer / e2e changes

- Run checks in the actual container image, not just on the host: lint,
  `test:coverage`, `build`, and, for scheduled-run parity, the e2e suite
  (`npm run test:e2e`).
- Playwright baselines (`e2e/*-snapshots/*.png`) that drift after a dependency
  or rendering change must be regenerated in a **Linux container** on the same
  Playwright base the devcontainer uses — not on a macOS/Windows host — so they
  match CI rendering. Prefer the project's own image/`scripts/` helpers when
  available.

## Housekeeping

- Large local scratch/analysis artifacts (browser caches, gh cache dirs, etc.)
  should be gitignored (see `.gitignore` for `.ghcache/`, `.pw-browsers/`) and
  cleaned up; never commit them.
