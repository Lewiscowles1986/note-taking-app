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

## Vendored wasm bundles: one build per line, latest patch

`public/python-wasm/`, `public/ruby-wasm/`, `public/php-wasm/` and the other
vendored language matrices ship **one bundle per upstream major.minor line** —
the latest release of that line, not every release of it.

- When a newer patch of an existing line is vendored (`3.15.1` arriving over
  `3.15.0`), **replace** that bundle and its entry in the runner's table. Do
  not keep the superseded build as a second selectable version: two labels for
  one line makes the version selector ambiguous, and every retained bundle is
  committed bytes the deployment carries.
- A pre-release is superseded by the final release of the same line.
  `3.15.0rc2` and `3.15.0` are one line, so the rc goes when the final lands.
- A distinct line — a new major.minor, or an old one re-vendored — is a
  **new** bundle, not a replacement. Superseding is about patch releases within
  a line, never about trimming lines the matrix exists to cover.
- Vendor through `scripts/vendor-wasm.mjs` rather than copying files by hand,
  so `vendor.json` records hashes of what actually ships.
- Regenerate the catalog with `scripts/build-wasm-index.mjs` for every language
  whose runner reads it; the `src/test/*Bundles.test.ts` integrity tests fail
  when a runner table and the vendored directories disagree.

The Ruby matrix was pruned to exactly this rule (its six redundant bundles were
each a line's *first* release), so treat one-build-per-line as the established
shape rather than a new preference.

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
