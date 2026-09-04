#!/usr/bin/env bash
# Builds the devcontainer BASE image from source (flake.lock toolchain +
# pinned Playwright base + user setup). The dev container normally consumes
# the published multi-arch image; run this after editing flake.nix or
# .devcontainer/base.Dockerfile, or when no published image is available.
#
# Usage:
#   scripts/build-devcontainer-base.sh          # build for the host architecture
#   scripts/build-devcontainer-base.sh --push   # build amd64+arm64 and publish
#
# After a local build, devcontainer.json references the exact same tag, so
# "Reopen in Container" / `devcontainer up` uses your freshly built image.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/lewiscowles1986/note-taking-app/devcontainer"
DOCKERFILE="$ROOT_DIR/.devcontainer/base.Dockerfile"

# Single source of truth for the version: the ARG default in base.Dockerfile.
VERSION="$(sed -nE 's/.*playwright:v([0-9]+\.[0-9]+\.[0-9]+)-noble.*/\1/p' "$DOCKERFILE" | head -n1)"
if [ -z "$VERSION" ]; then
  echo "Could not derive the Playwright version from .devcontainer/base.Dockerfile" >&2
  exit 1
fi

if [ "${1:-}" = "--push" ]; then
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -f "$DOCKERFILE" "$ROOT_DIR" \
    -t "$IMAGE:$VERSION-amd64" -t "$IMAGE:$VERSION-arm64" \
    --push
  docker buildx imagetools create \
    -t "$IMAGE:$VERSION" -t "$IMAGE:latest" \
    "$IMAGE:$VERSION-amd64" "$IMAGE:$VERSION-arm64"
  echo "Published $IMAGE:$VERSION and $IMAGE:latest (multi-arch)."
else
  docker buildx build --load \
    -f "$DOCKERFILE" "$ROOT_DIR" \
    -t "$IMAGE:$VERSION" -t "$IMAGE:latest"
  echo "Built $IMAGE:$VERSION for the host architecture."
  echo "devcontainer.json references this exact tag, so the dev container will use it."
fi