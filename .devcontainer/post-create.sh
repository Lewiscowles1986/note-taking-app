#!/usr/bin/env bash
# Container lifecycle: install npm dependencies, then verify that the
# Playwright browsers baked into the devcontainer image still match the
# @playwright/test version resolved by package-lock.json. Runs on container
# creation (devcontainer.json postCreateCommand) and therefore also in CI
# (devcontainers/ci), where a mismatch fails the build loudly.
set -euo pipefail
cd "$(dirname "$0")/.." # workspace root inside the container

# Docker creates named volumes root-owned, but the dev user is non-root, so
# take ownership of node_modules before installing (fast no-op when it is
# already owned correctly). The dev user has passwordless sudo for exactly
# this kind of one-time setup.
NODE_MODULES="${PWD}/node_modules"
if [ -d "$NODE_MODULES" ] && [ "$(stat -c '%U' "$NODE_MODULES" 2>/dev/null)" != "$(id -un)" ]; then
  echo "==> fixing ownership of node_modules volume (root -> $(id -un))"
  sudo chown -R "$(id -u):$(id -g)" "$NODE_MODULES"
fi

echo "==> node $(node --version) / npm $(npm --version) / git $(git --version)"
npm ci

PW_NPM="$(node -p "require('@playwright/test/package.json').version")"
PW_TAG="${PW_IMAGE_TAG:-}"
PW_BASE="${PW_TAG##*:}"  # mcr.microsoft.com/playwright:v1.58.2-noble -> v1.58.2-noble
PW_BASE="${PW_BASE#v}"   # -> 1.58.2-noble
PW_BASE="${PW_BASE%%-*}" # -> 1.58.2

if [ -n "$PW_TAG" ] && [ "$PW_NPM" != "$PW_BASE" ]; then
  cat >&2 <<EOF

ERROR: Playwright version mismatch
  npm lockfile:       @playwright/test ${PW_NPM}
  devcontainer image: ${PW_TAG} (browsers for ${PW_BASE})

Browsers baked into mcr.microsoft.com/playwright images only match one
@playwright/test minor series. Fix the pair:
  1. set ARG PLAYWRIGHT_IMAGE in .devcontainer/base.Dockerfile to
     mcr.microsoft.com/playwright:v${PW_NPM}-noble
  2. update the tag in devcontainer.json ("image": ...:${PW_NPM})
     and the IMAGE tag in scripts/e2e-docker.sh to match
  3. publish: scripts/build-devcontainer-base.sh --push
Stopgap (not reproducible): run "npx playwright install chromium" to download
matching browsers for this one container.

EOF
  exit 1
fi
echo "==> playwright pairing OK: @playwright/test ${PW_NPM} == image ${PW_BASE}"