#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.58.2-noble"

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
