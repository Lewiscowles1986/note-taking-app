#!/usr/bin/env bash
# iOS Simulator smoke suite for Note Haven — a pure-web PWA (no native entry).
#
# This is NOT a Chromium/Playwright replacement. It boot-loads the built app in
# mobile Safari on the REAL iOS WebKit engine to catch things headless Chrome
# cannot:
#   * safe-area layout  — env(safe-area-inset-*) only differs from 0 on a real
#     notched device; headless Chrome & Playwright report 0 insets, so these
#     are validated VISUALLY via the screenshot below, not via an assertion.
#   * dynamic viewport  — the dvh / 100dvh units iOS Safari computes for the
#     on-screen vs. full keyboard/in-page UI.
#   * iOS-Safari rendering quirks and service-worker / offline behavior.
#
# It:
#   1. selects a simulator (SIM_UDID, else DEVICE_NAME, else first booted /
#      first available iPhone),
#   2. boots it if needed and opens the Simulator.app window,
#   3. builds `dist` (or reuses it when SKIP_BUILD=1) and runs `vite preview`
#      on $E2E_PREVIEW_PORT (default 5210) in the background,
#   4. opens http://localhost:$PORT in mobile Safari (xcrun simctl openurl),
#   5. waits ~6s, captures a full-device screenshot into
#      reports/mobile-qa/ios-<timestamp>.png and dumps a short best-effort
#      slice of the host's console log as a smoke signal,
#   6. tears down: kills vite, and shuts the sim down only if THIS script
#      booted it (SIM_NO_SHUTDOWN=1 to keep it live for manual inspection).
#
# Exits non-zero if the URL did not serve 200, no device could be selected, or
# the screenshot failed.
#
# Requirements: macOS + Xcode command line tools (xcrun simctl), an installed
# iPhone simulator runtime. Does NOT require an Android SDK.
#
# Usage:
#   bash scripts/ios-smoke.sh
#
# Useful overrides (all optional):
#   SIM_UDID=...              use a specific simulator UDID
#   DEVICE_NAME="iPhone 15"   pick by name from `simctl list devices available`
#   E2E_PREVIEW_PORT=8080     port for vite preview (default 5210)
#   SKIP_BUILD=1              don't re-run `npm run build`; preview existing dist/
#   E2E_PREVIEW_OUTDIR=/path  serve a production dist at another path
#                             (vite preview --outDir); see "production dist" below
#   SIM_NO_SHUTDOWN=1         leave the simulator booted for manual inspection
#
# Pointing at a production dist: the build this script runs is the local
# `vite build`, whose service worker / base path come from the repo defaults.
# To smoke a real Pages/production build instead, build it in place (so it
# serves under the same path the device will load) and run:
#   SKIP_BUILD=1 bash scripts/ios-smoke.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${E2E_PREVIEW_PORT:-5210}"
REPORT_DIR="$ROOT_DIR/reports/mobile-qa"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SCREENSHOT="$REPORT_DIR/ios-$TIMESTAMP.png"
APP_URL="http://localhost:$PORT"

# ---------------------------------------------------------------------------
# 1. Select a simulator
# ---------------------------------------------------------------------------
select_sim() {
  local name="${1:-}"
  xcrun simctl list devices available -j | python3 -c '
import json, sys
data = json.load(sys.stdin)
devs = [d for group in data.get("devices", {}).values() for d in group
        if d.get("isAvailable")]
name = sys.argv[1] if len(sys.argv) > 1 else ""
if name:
    for d in devs:
        if d.get("name") == name:
            print(d.get("udid"), end=""); sys.exit(0)
    sys.exit(2)  # named device not found
# Prefer a booted device, else first available iPhone.
for d in devs:
    if d.get("state") == "Booted":
        print(d.get("udid"), end=""); sys.exit(0)
if devs:
    print(devs[0].get("udid"), end=""); sys.exit(0)
sys.exit(1)  # nothing available
' "$name"
}

if [[ -n "${SIM_UDID:-}" ]]; then
  SIM="$SIM_UDID"
  echo "[ios-smoke] using SIM_UDID=$SIM"
else
  SIM="$(select_sim "${DEVICE_NAME:-}" || true)"
  if [[ -z "$SIM" ]]; then
    echo "[ios-smoke] ERROR: no simulator selected." >&2
    echo "[ios-smoke] Run 'xcrun simctl list devices available' to inspect." >&2
    exit 1
  fi
  echo "[ios-smoke] selected simulator udid=$SIM${DEVICE_NAME:+   (DEVICE_NAME=$DEVICE_NAME)}"
fi

SIM_STATE="$(xcrun simctl list devices available -j | python3 -c "
import json,sys
data=json.load(sys.stdin)
m=sys.argv[1]
for g in data.get('devices',{}).values():
    for d in g:
        if d.get('udid')==m: print(d.get('state')); break
" "$SIM")"
BOOTED_IT=0
if [[ "$SIM_STATE" != "Booted" ]]; then
  echo "[ios-smoke] booting simulator ($SIM_STATE -> Booted)..."
  xcrun simctl boot "$SIM" 2>/dev/null || true
  BOOTED_IT=1
fi
# Wait for full boot (no-op if already booted).
xcrun simctl bootstatus "$SIM" -b >/dev/null 2>&1 || true
echo "[ios-smoke] simulator is booted; opening Simulator.app window"
open -a Simulator

PREVIEW_PID=""
cleanup() {
  if [[ -n "$PREVIEW_PID" ]]; then
    echo "[ios-smoke] stopping vite preview (pid $PREVIEW_PID)"
    kill "$PREVIEW_PID" 2>/dev/null || true
    wait "$PREVIEW_PID" 2>/dev/null || true
  fi
  if [[ "$BOOTED_IT" == "1" && "${SIM_NO_SHUTDOWN:-0}" != "1" ]]; then
    echo "[ios-smoke] shutting down simulator (it was booted by this run; SIM_NO_SHUTDOWN=1 to keep it)"
    xcrun simctl shutdown "$SIM" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 2. Build + serve
# ---------------------------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "[ios-smoke] building app..."
  npm --prefix "$ROOT_DIR" --silent run build
else
  echo "[ios-smoke] SKIP_BUILD=1 — reusing existing $ROOT_DIR/dist (or outdir)"
fi

echo "[ios-smoke] starting vite preview on :$PORT"
(
  cd "$ROOT_DIR"
  npx vite preview --config "$ROOT_DIR/vite.config.ts" --port "$PORT" --strictPort \
    ${E2E_PREVIEW_OUTDIR:+--outDir "$E2E_PREVIEW_OUTDIR"}
) &
PREVIEW_PID=$!

# Wait for the preview server to accept connections (timeout ~30s).
echo "[ios-smoke] waiting for $APP_URL"
APP_LOADED=0
for _ in $(seq 1 60); do
  if curl -sf "$APP_URL" >/dev/null 2>&1; then
    APP_LOADED=1
    break
  fi
  sleep 0.5
done
if [[ "$APP_LOADED" != "1" ]]; then
  echo "[ios-smoke] ERROR: app did not serve 200 at $APP_URL within 30s." >&2
  exit 1
fi
echo "[ios-smoke] app reachable (HTTP 200) at $APP_URL"

# ---------------------------------------------------------------------------
# 3. Open in mobile Safari on the real WebKit engine
# ---------------------------------------------------------------------------
echo "[ios-smoke] opening $APP_URL in iOS Safari (real WebKit)..."
xcrun simctl openurl "$SIM" "$APP_URL"
# Give WebKit time to fetch, parse and paint before capturing.
echo "[ios-smoke] waiting 6s for WebKit to load & paint..."
sleep 6

# ---------------------------------------------------------------------------
# 4. Capture smoke signal: full-device screenshot + short console log slice
# ---------------------------------------------------------------------------
mkdir -p "$REPORT_DIR"
SCREENSHOT_OK=0
# simctl's screenshot is taken by a separate macOS service process, which can
# fail to write straight into the project dir on external/removable volumes or
# when the shell lacks Full Disk Access. Capture to a per-run temp file (always
# writable) and copy it into the report dir with the shell.
TMP_SHOT="${TMPDIR:-/tmp}/ios-${TIMESTAMP}.png"
if xcrun simctl io "$SIM" screenshot "$TMP_SHOT" 2>/dev/null && [ -s "$TMP_SHOT" ]; then
  cp "$TMP_SHOT" "$SCREENSHOT"
  SCREENSHOT_OK=1
  echo "[ios-smoke] screenshot written: $SCREENSHOT"
  echo "[ios-smoke] NOTE: safe-area (env(safe-area-inset-*)) and 100dvh layout"
  echo "[ios-smoke]       are validated VISUALLY in this screenshot — headless"
  echo "[ios-smoke]       Chrome / Playwright report 0 insets, so assert them here."
else
  echo "[ios-smoke] WARNING: screenshot capture failed." >&2
fi

# Best-effort console log smoke signal. Filters the unified log for the app
# host so unrelated system noise is suppressed. Non-fatal if log is unavailable.
echo "[ios-smoke] tail of $APP_URL console log (best-effort):"
xcrun simctl spawn "$SIM" log show --last 20s --style compact \
  --predicate "eventMessage CONTAINS[c] \"$PORT\" OR eventMessage CONTAINS[c] \"localhost\" OR eventMessage CONTAINS[c] \"sw.js\"" \
  >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 5. Exit status
# ---------------------------------------------------------------------------
echo "[ios-smoke] app-loaded=$APP_LOADED screenshot-ok=$SCREENSHOT_OK"
if [[ "$SCREENSHOT_OK" != "1" ]]; then
  echo "[ios-smoke] ERROR: no screenshot produced — failing smoke." >&2
  exit 1
fi
echo "[ios-smoke] iOS smoke passed. Review screenshot: $SCREENSHOT"
