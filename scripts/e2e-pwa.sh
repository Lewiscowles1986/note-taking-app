#!/usr/bin/env bash
# Build the app and run the PWA/service-worker offline e2e against `vite preview`.
#
# The service worker is only generated at build time (vite-plugin-pwa has no
# devOptions.enabled), so this suite cannot run against the dev server — it must
# attach to `vite preview` of `dist`. This script:
#   1. builds the app (emits dist/sw.js + workbox runtime),
#   2. boots `vite preview` on $E2E_PREVIEW_PORT (default 5199),
#   3. runs e2e/offline.mobile.spec.ts in attach mode with E2E_PWA=1.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${E2E_PREVIEW_PORT:-5199}"

echo "[e2e-pwa] building app..."
npm --prefix "$ROOT_DIR" --silent run build

echo "[e2e-pwa] starting vite preview on :$PORT"
(
  cd "$ROOT_DIR"
  npx vite preview --config "$ROOT_DIR/vite.config.ts" --port "$PORT" --strictPort
) &

PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true' EXIT

# Wait for the preview server to accept connections (timeout ~30s).
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "[e2e-pwa] running offline suite against http://localhost:$PORT"
cd "$ROOT_DIR"
E2E_PWA=1 \
E2E_NO_SCREENSHOTS=1 \
E2E_BASE_URL="http://localhost:$PORT" \
  npx playwright test e2e/offline.mobile.spec.ts --project=chromium-mobile --reporter=list
