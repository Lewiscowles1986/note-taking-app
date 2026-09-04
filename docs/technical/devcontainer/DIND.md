# Docker in the Dev Container: socket mount (DooD), not Docker-in-Docker

## Decision

The dev container **mounts the host Docker socket** (`/var/run/docker.sock`,
configured in `.devcontainer/devcontainer.json`) and provides the `docker`
CLI from the pinned Nix toolchain. It deliberately does **not** run a nested
Docker daemon (Docker-in-Docker, "DinD"). This is the
"Docker-out-of-Docker" (**DooD**) pattern.

## Why the socket mount wins here

| Concern | DooD (socket mount — chosen) | DinD (nested daemon) |
|---|---|---|
| Privileges | None beyond socket access | Container must run `--privileged` |
| Image cache | Shares the host daemon — `mcr.microsoft.com/playwright:*` images already pulled for `scripts/e2e-docker.sh` are reused, not re-downloaded | Separate cache: every nested build re-pulls images into a private namespace |
| Version skew | Impossible — there is exactly one daemon (the host's) | Nested daemon versions drift from the host and from each other |
| Storage/perf | Reuses host overlayfs | Nested overlayfs on overlayfs; slower and more disk-hungry |
| Lifecycle | Nothing to babysit | A daemon must boot inside the container before any `docker` command works |
| Security surface | Equivalent in practice: socket access is root-equivalent on the host daemon | `--privileged` is a *wider* hole (full device/module access) |

In short: DinD only makes sense when you need to *manage containers with
different isolation semantics* (e.g. test a CI runner itself). Here we just
need to *talk to* the same daemon the developer already has, so DooD is
strictly simpler and cheaper.

Verified in practice (2026-09): from inside the dev container,
`docker version` reports `client 29.7.2 / server 29.7.2` through the mounted
socket — one daemon (the host's), no `--privileged`, no nested daemon to boot,
and the Playwright images `scripts/e2e-docker.sh` already pulled are reused
directly. A nested DinD daemon would have delivered a *second*, isolated
cache instead.

## What this enables inside the container

- `docker build`, `docker run`, `docker compose` against the host daemon.
- `act` (local GitHub Actions replay, mentioned in the root README).
- Running container-based helper scripts without leaving the container.

Note that the project's E2E suite **does not need Docker at all** inside the
dev container: Playwright runs against the browser builds baked into the
image. Prefer `npm run test:e2e` in-container; `npm run docs:screenshots:docker`
(`scripts/e2e-docker.sh`) is a *host-side* convenience for environments where
Node/Playwright are not installed.

## Caveats you should actually know about

### 1. Socket access is root-equivalent on the host

Anything able to talk to `/var/run/docker.sock` can mount the host filesystem,
become root on the host, or start privileged containers. Mounting it into the
dev container is only appropriate because the container runs *your own
trusted* code. Never use this dev container to run untrusted code with the
socket attached. If you need harder isolation: run a rootless daemon
(rootless Docker / Podman exposes a per-user socket at the same path) and drop
the `sudo` usage in `.devcontainer/fix-docker-group.sh`.

### 2. Nested `docker run -v` path mapping

With DooD, `docker run -v <path>` inside the container is interpreted by the
**host** daemon, so `<path>` must exist **on the host**. Container-internal
paths usually don't (`/workspaces/note-taking-app` exists in the container,
not on a macOS host). That is why `scripts/e2e-docker.sh` (which bind-mounts
the repo) is documented as a host-side script: run it from the host shell, or
just run `npm run test:e2e` inside the container.

### 3. Codespaces has no socket

There is no host daemon in the cloud. The bind mount resolves to an empty
path, `.devcontainer/fix-docker-group.sh` reports that docker is unavailable
and exits 0, and everything else (Node, npm, Playwright browsers) works as
normal. Don't rely on `docker` inside Codespaces.

### 4. Group permissions (bare-metal Linux hosts)

On Linux the socket is `root:docker 0660`; the container's `docker` group GID
rarely matches the host's. `postStartCommand` runs
`.devcontainer/fix-docker-group.sh`, which syncs the container group's GID to
the socket's and adds the dev user to it (via passwordless sudo). New
terminals pick it up; an already-open terminal needs `newgrp docker`.
Docker Desktop (macOS/Windows) mounts the socket root-owned (GID 0); there the
script instead opens it to container users with `sudo chmod 0666` — acceptable
because socket access is already host-root-equivalent (see caveat 1).

### 5. CI isolation

`.github/workflows/devcontainer.yml` builds the same image and runs the
project's checks (including scheduled E2E) **inside** the container without
ever using Docker from within it. The socket mount is inert there (the
runner's socket exists, but no container code touches it) — which keeps CI
reproducible: the checks exercise exactly what ships in the image, and
nothing leaks from the daemon into the result.

## If you ever do want DinD

The supported path is the official feature:

```jsonc
"features": {
  "ghcr.io/devcontainers/features/docker-in-docker:2": {}
}
```

It installs a daemon inside the container (and requires a privileged
container). Expect a separate image cache from the host, slower builds, and a
broader security surface — then prefer it only if you need to test
daemon behaviour itself. For this repository, the socket mount is the right
default; remove the mount from `devcontainer.json` if you'd rather have a
strictly isolated container (everything still works — only `docker`/`act`
inside the container stop being available).