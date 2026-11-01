#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Single source of truth for the Playwright version: the ARG default in
# .devcontainer/base.Dockerfile (the same value the devcontainer image is
# tagged with). Deriving it keeps this script from silently pinning an old
# browser build that no longer matches the npm lockfile.
PW_VERSION="$(sed -nE 's/.*playwright:v([0-9]+\.[0-9]+\.[0-9]+)-noble.*/\1/p' \
  "$ROOT_DIR/.devcontainer/base.Dockerfile" | head -n1)"
if [ -z "$PW_VERSION" ]; then
  echo "Could not derive the Playwright version from .devcontainer/base.Dockerfile" >&2
  exit 1
fi
IMAGE="mcr.microsoft.com/playwright:v${PW_VERSION}-noble"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Start Docker Desktop or install Docker, then rerun this command." >&2
  exit 127
fi

exec docker run --rm --init --ipc=host \
  --env E2E_DOCS=1 \
  --volume "$ROOT_DIR:/work" \
  --volume note-haven-playwright-node-modules:/work/node_modules \
  --workdir /work \
  "$IMAGE" \
  bash -lc 'npm ci && npm run docs:screenshots'
