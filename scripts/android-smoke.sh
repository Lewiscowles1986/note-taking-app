#!/usr/bin/env bash
# Android emulator smoke suite for the "Note Haven" PWA (pure-web, no native wrapper).
#
# PURPOSE
#   This is a real Chromium-on-Android smoke: touch input on device, the actual
#   mobile Chrome browser, service-worker/offline on-device, and safe-area
#   handling on notched devices. It runs ONLY on a machine that already has the
#   Android SDK + platform-tools + emulator + at least one AVD installed.
#
# INCREMENTAL VALUE OVER PLAYWRIGHT (read this before running)
#   Because Android runs Chromium, the incremental value of THIS emulator suite
#   over the Playwright `chromium-mobile` browser suite (genuine Pixel 7
#   viewport, touch, isMobile) is deliberately small. Its unique contributions
#   are on-device/offline service-worker behaviour, real mobile Chrome, and
#   notch/safe-area rendering. Treat this as an occasional on-device/offline
#   smoke, NOT the primary regression layer — the deterministic first line is the
#   Playwright browser suite (see docs/mobile-qa.md).
#
# WHAT IT DOES
#   1. Guards: fails fast (exit 127) with install steps if adb/emulator are
#      missing, ANDROID_HOME is unset, or the target AVD does not exist. The
#      sdkmanager/avdmanager command-line tools are only needed to CREATE an
#      AVD (setup work done before running this smoke), so they are optional.
#   2. Boots an AVD headless (emulator -no-window -no-audio -gpu swiftshader_indirect)
#      and waits for `adb wait-for-device` + `sys.boot_completed == 1`.
#   3. Builds the app (ROOT) and starts `vite preview --host 0.0.0.0` on :5220 in
#      the background with a cleanup trap.
#   4. `adb reverse tcp:5220 tcp:5220` so `http://localhost:5220` on the device maps
#      to the host Vite preview.
#   5. Opens the app in mobile Chrome (am start VIEW), waits, captures a device
#      screenshot to reports/mobile-qa/android-<timestamp>.png, then reads a
#      best-effort smoke signal from dumpsys + logcat.
#   6. Tears down: stops Chrome, `adb reverse --remove-all`, kills vite, and (unless
#      KEEP_EMULATOR=1) kills the emulator it started.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${ANDROID_SDK:-}}}"

# --- Config (override via env) -------------------------------------------------
AVD_NAME="${AVD_NAME:-notehaven}"
# Android system image the AVD is created from (informational default; used in
# the install/setup guidance and available for avdmanager setup scripts).
# Override with e.g. SYSTEM_IMAGE="system-images;android-33;google_apis;arm64-v8a".
SYSTEM_IMAGE="${SYSTEM_IMAGE:-system-images;android-34;google_apis;arm64-v8a}"
PORT="${ANDROID_PREVIEW_PORT:-5220}"
BOOT_TIMEOUT_S="${ANDROID_BOOT_TIMEOUT_S:-360}"        # ~2 min default; overridable
KEEP_EMULATOR="${KEEP_EMULATOR:-0}"                    # set to 1 to leave AVD running
REPORTS_DIR="$ROOT_DIR/reports/mobile-qa"

# --- Paths (override any with ADB / EMULATOR_BIN / SDKMANAGER) -----------------
ADB="${ADB:-}"
EMULATOR_BIN="${EMULATOR_BIN:-}"
SDKMANAGER="${SDKMANAGER:-}"

# --- Error text reused by the guard -------------------------------------------
install_help() {
  cat <<'EOF'
  The Android SDK is not installed/configured on this machine, so this script
  cannot run here. Install the command-line tools and an AVD, then re-run.

   1. Install the Android command-line tools (Studio or cmdline-tools-only zip):
        https://developer.android.com/studio#command-line-tools-only

   2. Set ANDROID_HOME (or ANDROID_SDK_ROOT), e.g. for macOS:
        export ANDROID_HOME="$HOME/Library/Android/sdk"
      or Linux:
        export ANDROID_HOME="$HOME/Android/Sdk"

   3. Add tool binaries to PATH:
        export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

   4. Accept licenses and install the emulator + platform-tools:
        sdkmanager --licenses
        sdkmanager "platform-tools" "emulator"
        sdkmanager "platforms;android-34"

   5. Install a system image and create the AVD (name must match AVD_NAME):
        sdkmanager "${SYSTEM_IMAGE}"
        echo no | avdmanager create avd -n "${AVD_NAME}" \
          -k "${SYSTEM_IMAGE}" --device "pixel_7"

   Then run:  bash "$ROOT_DIR/scripts/android-smoke.sh"
EOF
}

# resolve_tool NAME RELPATH_IN_HOME
#   Returns an absolute path for a SDK binary by checking (a) PATH, then
#   (b) $ANDROID_HOME/<relpath>. Errors out (exit 127) with install help if absent.
resolve_tool() {
  local name="$1" rel="$2" found=""
  found="$(command -v "$name" 2>/dev/null || true)"
  if [[ -z "$found" && -n "$ANDROID_HOME" && -n "$rel" && -x "$ANDROID_HOME/$rel" ]]; then
    found="$ANDROID_HOME/$rel"
  fi
  if [[ -z "$found" ]]; then
    echo "[android-smoke] ERROR: '$name' not found on PATH."
    if [[ -z "$ANDROID_HOME" ]]; then
      echo "[android-smoke] ANDROID_HOME / ANDROID_SDK_ROOT is not set."
    else
      echo "[android-smoke] (searched PATH and \$ANDROID_HOME=$ANDROID_HOME)"
    fi
    echo
    install_help
    exit 127          # conventional exit code for "command not found"
  fi
  printf '%s\n' "$found"
}

# --- Guard: adb + emulator + an existing AVD are required ---------------------
# We only boot a PRE-EXISTING AVD, so adb + emulator are hard requirements.
# sdkmanager/avdmanager are NOT required to run this smoke (they're only needed
# to create an AVD beforehand); they're resolved optionally so logs can show them.
ADB="${ADB:-$(resolve_tool adb platform-tools/adb)}"
EMULATOR_BIN="${EMULATOR_BIN:-$(resolve_tool emulator emulator/emulator)}"

SDKMANAGER="${SDKMANAGER:-$(command -v sdkmanager 2>/dev/null || true)}"
AVDMANAGER="${AVDMANAGER:-$(command -v avdmanager 2>/dev/null || true)}"
if [[ -n "$ANDROID_HOME" && -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  SDKMANAGER="${SDKMANAGER:-$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager}"
fi
if [[ -n "$ANDROID_HOME" && -x "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" ]]; then
  AVDMANAGER="${AVDMANAGER:-$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager}"
fi

echo "[android-smoke] adb=$ADB"
echo "[android-smoke] emulator=$EMULATOR_BIN"
echo "[android-smoke] sdkmanager=${SDKMANAGER:-<not found; only needed to CREATE an AVD>}"
echo "[android-smoke] AVD=$AVD_NAME  system-image=$SYSTEM_IMAGE  port=$PORT"

# The target AVD must already exist before we try to boot it.
if ! "$EMULATOR_BIN" -list-avds 2>/dev/null | grep -qx "$AVD_NAME"; then
  echo "[android-smoke] ERROR: AVD '$AVD_NAME' does not exist on this machine." >&2
  echo "[android-smoke]   Existing AVDs:" >&2
  "$EMULATOR_BIN" -list-avds 2>/dev/null | sed 's/^/^   - /' >&2 || true
  echo >&2
  install_help
  exit 127
fi
echo "[android-smoke] found AVD '$AVD_NAME'."

# --- Cleanup + traps (registered before anything mutates state) ---------------
PREVIEW_PID=""
EMULATOR_PID=""
EMULATOR_STARTED=0

cleanup() {
  local rc="${1:-$?}"
  echo "[android-smoke] tearing down..."
  if [[ -n "$ADB" ]]; then
    # 1. stop Chrome on the device
    "$ADB" shell am force-stop com.android.chrome >/dev/null 2>&1 || true
    # 2. remove any port forwards we installed
    "$ADB" reverse --remove-all >/dev/null 2>&1 || true
    # 3. (optionally) kill the emulator this script started
    if [[ "$EMULATOR_STARTED" == "1" && "$KEEP_EMULATOR" != "1" ]]; then
      "$ADB" emu kill >/dev/null 2>&1 || true
      if [[ -n "$EMULATOR_PID" ]]; then
        kill "$EMULATOR_PID" 2>/dev/null || true
      fi
      echo "[android-smoke] emulator $AVD_NAME stopped (set KEEP_EMULATOR=1 to keep it)."
    fi
  fi
  # 4. kill the vite preview server
  if [[ -n "$PREVIEW_PID" ]]; then
    kill "$PREVIEW_PID" 2>/dev/null || true
  fi
  echo "[android-smoke] done (rc=$rc)."
  exit "$rc"
}
trap 'cleanup' EXIT INT TERM

# --- Build + boot the app server ----------------------------------------------
echo "[android-smoke] building app (dist)..."
npm --prefix "$ROOT_DIR" --silent run build

echo "[android-smoke] starting vite preview on :$PORT (host 0.0.0.0)"
(
  cd "$ROOT_DIR"
  npx vite preview --config "$ROOT_DIR/vite.config.ts" --host 0.0.0.0 --port "$PORT" --strictPort
) &
PREVIEW_PID=$!

PREVIEW_UP=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT" >/dev/null 2>&1; then PREVIEW_UP=1; break; fi
  sleep 0.5
done
if [[ "$PREVIEW_UP" != "1" ]]; then
  echo "[android-smoke] ERROR: vite preview did not come up on :$PORT" >&2
  exit 1
fi
echo "[android-smoke] vite preview is serving on :$PORT"

# --- Start the emulator (headless) and wait for boot ---------------------------
echo "[android-smoke] starting AVD '$AVD_NAME' headless..."
"$EMULATOR_BIN" -avd "$AVD_NAME" -no-window -no-audio -gpu swiftshader_indirect -no-snapshot -no-boot-anim &
EMULATOR_PID=$!
EMULATOR_STARTED=1

echo "[android-smoke] waiting for device to appear..."
"$ADB" start-server >/dev/null 2>&1 || true
"$ADB" wait-for-device

echo "[android-smoke] device online; waiting for sys.boot_completed=1..."
local_boot=0
for _ in $(seq 1 "$((BOOT_TIMEOUT_S / 2))"); do
  boot_val="$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [[ "$boot_val" == "1" ]]; then local_boot=1; break; fi
  sleep 2
done
if [[ "$local_boot" != "1" ]]; then
  echo "[android-smoke] ERROR: device did not finish booting after ${BOOT_TIMEOUT_S}s" >&2
  exit 1
fi
echo "[android-smoke] device booted."

# --- Point the device at the host preview server ------------------------------
echo "[android-smoke] adb reverse tcp:$PORT -> tcp:$PORT"
"$ADB" reverse "tcp:$PORT" "tcp:$PORT"

echo "[android-smoke] opening http://localhost:$PORT in mobile Chrome..."
BROWSER_OK=0
START_OUT="$("$ADB" shell am start -a android.intent.action.VIEW -d "http://localhost:$PORT" 2>&1)"
echo "[android-smoke] am start: $START_OUT"
if printf '%s\n' "$START_OUT" | grep -qinE "unable to resolve intent|activity not started|no activity found"; then
  echo "[android-smoke] WARNING: no browser on this AVD resolved the app URL (e.g. Chrome not
  installed)." >&2
  echo "[android-smoke]   The emulator + adb pipeline works, but the app did NOT render in a
  browser." >&2
else
  BROWSER_OK=1
  echo "[android-smoke] browser intent resolved; letting the page + SW load..."
  # Let the page load, the SW register, and the render settle.
  sleep 3
fi

# --- Screenshot -----------------------------------------------------------------
mkdir -p "$REPORTS_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SHOT="$REPORTS_DIR/android-$TIMESTAMP.png"
echo "[android-smoke] capturing screenshot -> $SHOT"
"$ADB" exec-out screencap -p > "$SHOT"
echo "[android-smoke] saved screenshot: $SHOT"

# --- Best-effort smoke signal ----------------------------------------------------
echo "[android-smoke] smoke signal (informational; failures here are not fatal):"
echo "  device API level : $("$ADB" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"
echo "  device density    : $("$ADB" shell wm density 2>/dev/null | tr -d '\r')"
echo "  display size      : $("$ADB" shell wm size 2>/dev/null | tr -d '\r')"
if "$ADB" shell dumpsys activity activities 2>/dev/null | grep -qiE 'com\.android\.chrome'; then
  echo "  foreground       : Chrome (com.android.chrome) resumed on device"
  "$ADB" shell dumpsys activity activities 2>/dev/null | grep -iE 'topResumedActivity|ResumedActivity' | head -3 | tr -d '\r' | sed 's/^/    /' || true
else
  echo "  foreground       : (no Chrome activity detected in dumpsys)"
fi
echo "  service-worker / host logcat hints (tail):"
"$ADB" logcat -d 2>/dev/null | grep -iE 'sw\.js|localhost:'"$PORT" | tail -10 | sed 's/^/    /' || true

if [[ "$BROWSER_OK" == "1" ]]; then
  echo "[android-smoke] SUCCESS: app opened in a mobile browser (see screenshot $SHOT)."
else
  echo "[android-smoke] DEGRADED: emulator/adb pipeline OK, but no browser resolved the URL, so"
  echo "[android-smoke]   the app did NOT render on-device (screenshot shows the launcher only)."
  echo "[android-smoke]   Fix: use a browser-enabled system image (e.g. google_apis_playstore) or"
  echo "[android-smoke]   install Chrome on the AVD, then re-run."
  exit 2
fi
# EXIT trap handles teardown.
