#!/usr/bin/env bash
# One-command onboarding for the Note Haven dev container:
#   scripts/devcontainer-up.sh            # start (or reuse) the dev container
#   scripts/devcontainer-up.sh --check    # ...and verify lint/test/build inside it
#
# The container normally runs from the CI-published multi-arch image. If that
# image is not available locally (or not published yet), the base image is
# built from source automatically — everything is pinned, so the result is
# the same. See .devcontainer/README.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/lewiscowles1986/note-taking-app/devcontainer"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required (Docker Desktop, OrbStack, colima, ...)." >&2
  exit 127
fi

# Keep the @devcontainers/cli download in its own temp cache dir: isolates
# onboarding from a broken or root-owned global npm cache (~/.npm) on any host.
export npm_config_cache="${TMPDIR:-/tmp}/note-haven-devcontainer-cli"
mkdir -p "$npm_config_cache"

# Single source of truth for the tag: the image reference in devcontainer.json.
TAG="$(sed -nE 's/.*devcontainer:([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$ROOT_DIR/.devcontainer/devcontainer.json" | head -n1)"
if [ -z "$TAG" ]; then
  echo "Could not derive the image tag from .devcontainer/devcontainer.json" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE:$TAG" >/dev/null 2>&1; then
  echo "==> devcontainer image not present locally; pulling $IMAGE:$TAG"
  if ! docker pull "$IMAGE:$TAG"; then
    echo "==> pull failed (image not published yet, or private) — building from source"
    "$ROOT_DIR/scripts/build-devcontainer-base.sh"
  fi
fi

echo "==> starting the dev container (first run installs npm dependencies)"
npx --yes @devcontainers/cli up --workspace-folder "$ROOT_DIR"

if [ "${1:-}" = "--check" ]; then
  echo "==> verifying the environment: lint, tests, build"
  npx --yes @devcontainers/cli exec --workspace-folder "$ROOT_DIR" bash -lc \
    'npm run lint && npm test && npm run build'
fi

echo ""
echo "==> dev container is running."
echo "    VS Code:  'Dev Containers: Reopen in Container' / 'Attach to Running Container'"
echo "    CLI:      npx @devcontainers/cli exec --workspace-folder \"$ROOT_DIR\" bash"
echo "    Tear down when done: npx @devcontainers/cli down --workspace-folder \"$ROOT_DIR\""