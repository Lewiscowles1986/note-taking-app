#!/usr/bin/env bash
# Updates flake.lock to the newest commit of the nixpkgs branch pinned in
# flake.nix — WITHOUT requiring a local Nix installation. It runs
# `nix flake update` inside the same nixos/nix image version that
# .devcontainer/Dockerfile uses, so the result matches what CI builds.
#
# Usage: scripts/update-nix.sh
# After it finishes, review the flake.lock diff, commit, and rebuild your
# dev container ("Dev Containers: Rebuild Container" in VS Code).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NIX_IMAGE="nixos/nix:2.31.2" # keep in sync with .devcontainer/Dockerfile

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required (or install Nix locally and run 'nix flake update')." >&2
  exit 127
fi

# flake files must be git-tracked for nix to see them inside a git worktree.
git -C "$ROOT_DIR" add flake.nix flake.lock

docker run --rm -v "$ROOT_DIR":/w -w /w "$NIX_IMAGE" sh -c '
  echo "sandbox = false" > /etc/nix/nix.conf
  echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf
  nix flake update
'

# Re-stage so a follow-up nix operation (or another run) sees a clean state.
git -C "$ROOT_DIR" add flake.lock

echo ""
echo "flake.lock updated and staged. Review 'git diff --cached flake.lock', then commit and rebuild the dev container."