#!/usr/bin/env bash
#
# Note Haven E2E in Docker (Linux parity)
# =======================================
# Runs the full Playwright suite inside the official
# mcr.microsoft.com/playwright container so that visual baselines are rendered
# by Linux Chromium — the same rendering environment as CI. This keeps the
# committed PNG baselines canonical and reproducible regardless of the host OS.
#
# Usage:
#   scripts/e2e-docker.sh                 # full suite, both projects
#   scripts/e2e-docker.sh e2e/app.spec.ts  # a single spec file
#   scripts/e2e-docker.sh -u              # update snapshots (regenerate baselines)
#   scripts/e2e-docker.sh --project=chromium
#
# Any extra arguments are passed straight through to `npx playwright test`.
#
# node_modules caching
# --------------------
# The worktree's node_modules is a symlink to the host's macOS node_modules
# (native darwin binaries), which cannot run inside Linux. A persistent Docker
# named volume is mounted at the symlink's resolved target (/node_modules) to
# hold a Linux-native install. The first run runs `npm ci` (a few minutes);
# later runs skip it because the volume already contains node_modules/.bin/
# playwright. Delete the volume to force a clean reinstall:
#   docker volume rm note-haven-e2e-node_modules
#
# File ownership
# --------------
# The container runs as the invoking user (-u "$(id -u):$(id -g)") so files it
# writes into the mounted worktree (e.g. regenerated baselines) are owned by
# you, not root. A fresh named volume is root-owned, so the script does a cheap
# one-time `chown` of the volume to your uid:gid before the main run. HOME is
# set to /tmp because the container user's real home is not writable;
# npm/playwright caches land in /tmp and are discarded.

set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.58.2-noble"
VOLUME="note-haven-e2e-node_modules"

# --- Guard: docker must be present and running -------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 'docker' was not found on PATH." >&2
  echo "Install Docker Desktop (https://www.docker.com/products/docker-desktop/) and start it, then re-run." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: the Docker daemon is not running." >&2
  echo "Start Docker Desktop and wait for the engine to be ready, then re-run." >&2
  exit 1
fi

# --- Resolve the worktree root (this script lives in scripts/) ---------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- Pull the image if not already present -----------------------------------
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Pulling ${IMAGE} (first run only) ..."
  docker pull "${IMAGE}"
fi

# --- Ensure the node_modules volume exists and is owned by the user ----------
# The worktree's node_modules is a symlink to ../../node_modules, which Docker
# resolves to /node_modules inside the container, so the volume is mounted at
# /node_modules (the symlink's target). A fresh named volume is root-owned; a
# cheap root chown makes it writable by the invoking user.
if ! docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
  echo "Creating volume ${VOLUME} ..."
  docker volume create "${VOLUME}" >/dev/null
fi
echo "Ensuring ${VOLUME} is owned by $(id -u):$(id -g) ..."
docker run --rm \
  -v "${VOLUME}:/node_modules" \
  -u root \
  "${IMAGE}" \
  chown -R "$(id -u):$(id -g)" /node_modules

echo "Running E2E in Docker (${IMAGE}) ..."
echo "  worktree : ${ROOT}"
echo "  args     : $*"

# The container command:
#   1. Runs `npm ci` only if the persistent volume does not already contain a
#      Playwright install (fast marker check; skips on cached runs).
#   2. Execs `npx playwright test "$@"` with the caller's extra args.
# "$@" is forwarded as positional parameters to `bash -c` (the `_` is $0).
docker run --rm \
  -v "${ROOT}:/work" \
  -v "${VOLUME}:/node_modules" \
  -w /work \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "${IMAGE}" \
  bash -c '
    if [ ! -x node_modules/.bin/playwright ]; then
      echo "[docker] node_modules volume not populated — running npm ci (first run, may take a few minutes) ..."
      npm ci --no-audit --no-fund
    else
      echo "[docker] node_modules volume cached — skipping npm ci"
    fi
    exec npx playwright test "$@"
  ' _ "$@"
