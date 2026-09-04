# Dev Container — Note Haven

The dev container gives every contributor the same, fully pinned environment:
Node.js, npm, git and the docker CLI come from **Nix** (`flake.lock` pins the
exact nixpkgs revision), and the **Playwright browsers** matching the npm
lockfile are baked into the image. No "works on my machine" — and no Alpine.

## Quick start

**One command (any terminal with Docker):**

```bash
scripts/devcontainer-up.sh          # pulls the published image, or builds it from source
scripts/devcontainer-up.sh --check  # ...and verifies lint/tests/build inside it
```

**VS Code / VSCodium**
1. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) and Docker (Docker Desktop, OrbStack, colima, etc.).
2. Open the repository → command palette → **Dev Containers: Reopen in Container**.

The container runs from a prebuilt, multi-arch image published by CI
(`ghcr.io/lewiscowles1986/note-taking-app/devcontainer:<playwright-version>`)
— no local build needed. If the image is not published (or you built your own),
run `scripts/devcontainer-up.sh` (pulls or builds automatically), or build
explicitly:

```bash
scripts/build-devcontainer-base.sh
```

**CLI** (without VS Code):

```bash
npm exec --yes @devcontainers/cli -- up --workspace-folder .
npm exec --yes @devcontainers/cli -- exec --workspace-folder . bash
```

Once inside:

```bash
npm run dev        # Vite dev server (port 5173 is forwarded)
npm run build
npm test           # Vitest
npm run test:e2e   # Playwright — browsers are already installed in the image
npm run lint
```

## Architecture (two-stage)

1. **Base image** — `.devcontainer/base.Dockerfile` is built with plain
   `docker buildx`, *outside* the devcontainer tooling. It bakes in:
   the flake-locked toolchain (stage 1: `nix profile install`), the Playwright
   base image with matching browsers, a normalized `vscode` user, sudo, and
   the docker socket helper. Locally: `scripts/build-devcontainer-base.sh`
   (append `--push` to publish amd64+arm64). In CI:
   `.github/workflows/devcontainer.yml` builds it on native amd64 and arm64
   runners, runs all project checks inside it, and publishes multi-arch tags
   on `main`/schedule.
2. **Dev container** — `devcontainer.json` just references the published
   image (`"image": ...`) plus mounts, lifecycle scripts and editor
   customizations. Because the devcontainer CLI never rewrites the base
   Dockerfile, the base can use full Dockerfile syntax (ARG-before-FROM etc.).

## What's inside

| Tool    | Version                | Pinned by                        |
|---------|------------------------|----------------------------------|
| Node.js | 22.x (LTS)             | `flake.lock` → nixpkgs rev       |
| npm     | bundled with Node      | `flake.lock`                     |
| git     | pinned minor           | `flake.lock`                     |
| docker  | client only            | `flake.lock` (talks to host daemon — see [DIND.md](../docs/technical/devcontainer/DIND.md)) |
| Chromium/Firefox/WebKit | matches `@playwright/test` | `mcr.microsoft.com/playwright` image tag |

Design notes:

- `flake.nix` + `flake.lock` are the **single source of truth** for the
  toolchain. Nobody "installs node" anywhere.
- The image tag (`<playwright-version>`) and the Playwright base image in
  `base.Dockerfile` must stay in lockstep with the npm lockfile
  (`@playwright/test` ↔ `v<version>-noble`). `.devcontainer/post-create.sh`
  fails fast with instructions when they drift.
- `node_modules` lives in a named Docker volume so macOS (darwin/arm64)
  binaries from the host never leak into the Linux container, or vice versa.
- The first CI publish creates a *private* GHCR package — flip it to public
  once (Package settings → visibility) so everyone can pull it.
- E2E **visual baselines** are rendered by the devcontainer image (Linux
  Chromium), matching the repo's existing docker-based screenshot workflow.
  If rendering changes (Chromium bump, font changes), refresh them inside the
  container: `npx playwright test --update-snapshots`.

## Updating the toolchain

```bash
scripts/update-nix.sh              # runs `nix flake update` in a pinned nixos/nix container
git commit -m "chore: bump toolchain lock" flake.nix flake.lock
scripts/build-devcontainer-base.sh # rebuild the base image locally
# merge & push; CI re-validates and republishes the image
```

CI (`.github/workflows/devcontainer.yml`) also rebuilds and re-checks the
image **weekly on a schedule**, on both amd64 and arm64 runners, so a stale
lock or a moved base image is caught automatically.

## Updating Playwright

Bump `@playwright/test` in `package.json` (and `package-lock.json`), then:

1. set `ARG PLAYWRIGHT_IMAGE` in `.devcontainer/base.Dockerfile` to `mcr.microsoft.com/playwright:v<version>-noble`,
2. bump the tag in `devcontainer.json` (`"image": ...:<version>`) and the `IMAGE` tag in `scripts/e2e-docker.sh`,
3. `scripts/build-devcontainer-base.sh` (add `--push` to publish), commit, and let CI verify/publish.

## Docker access inside the container

The host Docker socket is mounted (`Docker-out-of-Docker`), so `docker`,
`scripts/e2e-docker.sh`-style flows and `act` (local CI replay) work without a
nested daemon. Read the reasoning and the caveats — including why a nested
Docker-in-Docker daemon was deliberately **not** used — in
[docs/technical/devcontainer/DIND.md](../docs/technical/devcontainer/DIND.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Reopen in Container" fails pulling `ghcr.io/...devcontainer:...` | Image not published yet (or private): run `scripts/devcontainer-up.sh`, which builds it from source automatically. |
| `docker: permission denied ... /var/run/docker.sock` | Run `sudo /usr/local/sbin/fix-docker-group` inside the container, then open a new terminal (or `newgrp docker`). |
| First create is slow | Normal: it pulls ~1.2 GB of image layers and runs `npm ci` once. Codespaces prebuilds (repo settings) cut this to seconds. |
| E2E snapshot diffs on macOS | Baselines are rendered by the container's Chromium (canonical). Run E2E in the container, or refresh locally with `npx playwright test --update-snapshots`. |
| Playwright "Executable doesn't exist" | The npm `@playwright/test` version and the image tag drifted — `post-create.sh` explains the exact pair to bump. |
| node_modules feels stale after pulling changes | `npm ci` inside the container (the volume is per-environment, like a fresh checkout). |