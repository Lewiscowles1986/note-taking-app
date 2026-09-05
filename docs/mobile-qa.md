# Mobile QA strategy

**Note Haven** is a pure-web PWA (Vite + React, no Capacitor / React-Native entry
point): everything is CSS/JS responsive and `useIsMobile()` keys off
`window.innerWidth < 768`. Because there is no native wrapper, mobile-QA is about
verifying the *web engine* and *device viewport* the app actually runs in. This
doc is the reference for the layered approach.

## The layers (coarse → to → fine-grained fidelity)

| Layer | Target | Cost | When |
|---|---|---|---|
| **Playwright browser suite** (primary deterministic regression) | Chromium + a `chromium-mobile` project | low; runs in CI on every PR | every commit |
| **iOS Simulator smoke** (real WebKit) | iOS Safari via `xcrun simctl` | medium; needs macOS + Xcode | on demand / release; safe-area, `100dvh`, offline, PWA |
| **Optional Playwright WebKit project** (Safari-approximation) | Playwright's bundled WebKit | low | optional, opt-in |
| **Android emulator** | Chrome (Chromium) on-device | high; needs Android SDK | occasional on-device/offline + notch smoke (`scripts/android-smoke.sh`) |

### 1. Playwright browser suite — the primary, deterministic regression

Existing `e2e/*.spec.ts`; runs on desktop Chromium and the `chromium-mobile`
project (genuine `Pixel 7` viewport + touch + `isMobile`). The suite is the
deterministic backstop for feature logic, CRUD flows, IndexedDB, encryption,
export/import, and rendering.

```bash
npm run test:e2e          # both projects
npx playwright test --project=chromium-mobile   # mobile viewport only
```

Project layout lives in `playwright.config.ts`. Exactly two projects exist:

- `chromium` — desktop Chromium 1440×900, runs the full suite.
- `chromium-mobile` — `devices['Pixel 7']`, `testMatch: '**/*mobile*.spec.ts'`
  (the desktop specs assume an always-visible `.w-72` sidebar that mobile replaces
  with a top sheet).

**Android emulator is intentionally not a cheap value-prop layer here**: its
browser is Chromium, i.e. the same engine Playwright already tests, so the
Chromium coverage is already carried by the deterministic suite. The emulator's
only unique value is **on-device/offline and notch/safe-area on a real Android
device**, which is exactly what `scripts/android-smoke.sh` exercises as an
*occasional* smoke — not the primary gate.

### 2. iOS Simulator smoke — real WebKit for what Chrome cannot see

This is the layer that actually earns the iOS coverage. It boots the built app in
**mobile Safari on the real iOS WebKit engine**, which is the one place
`env(safe-area-inset-*)`, dynamic-viewport (`dvh` / `100dvh`) and iOS-Safari
service-worker/offline behavior can be verified truthfully.

```bash
bash scripts/ios-smoke.sh
```

What it does: selects the first booted/available iPhone (or `SIM_UDID` /
`DEVICE_NAME="iPhone 15"`), boots + opens it, builds `dist` and serves it via
`vite preview` on `$E2E_PREVIEW_PORT` (default 5210), opens
`http://localhost:$PORT` in mobile Safari, waits ~6s, saves a full-device
screenshot to `reports/mobile-qa/ios-<timestamp>.png` (gitignored under
`reports/`), dumps a short best-effort console-log slice, and tears down.

```bash
SIM_UDID=DF1F1B02-F3C7-4106-86C4-566F11D1D27A bash scripts/ios-smoke.sh  # explicit device
DEVICE_NAME="iPhone 15" SKIP_BUILD=1 bash scripts/ios-smoke.sh            # reuse a prebuilt prod dist
SIM_NO_SHUTDOWN=1 bash scripts/ios-smoke.sh                                # leave sim booted for manual work
```

Because it shares the host network, the simulator reaches the `localhost`
preview server directly — no port-forwarding or build step is needed to install
anything (there is no native app to install).

**Prerequisites (macOS only):** Xcode command-line tools (`xcrun simctl`), an
iOS simulator runtime, and an installed iPhone simulator:
`xcrun simctl list devices available`. There is no Android-SDK dependency.

### 3. Optional Playwright WebKit — automated Safari-approximation

Playwright ships a bundled WebKit you can drive headlessly as a cheap,
automated, "is this Safari-ish" smoke:

```bash
npx playwright install webkit   # one-time; downloads Playwright's WebKit build
```

It would be wired as a **separate, opt-in `webkit-ios` project** (e.g.
`devices['iPhone 15']`) — NOT added to the existing `chromium` / `chromium-mobile`
projects, so it can never destabilize the current Chromium-only e2e baseline.
Treat WebKit as an approximation: it is Apple's engine but not the full iOS
WebKit shipping in Safari (no true safe-area insets, viewport units approximate),
so it does not replace the iOS-Simulator smoke for the visual cases below.

### 4. Android emulator smoke — occasional on-device/offline

Because Android runs Chromium, the **Playwright `chromium-mobile` suite is the
cheaper primary layer** for Android behaviour (genuine Pixel 7 viewport, touch,
`isMobile`). The emulator adds only what a browser projection cannot: real
on-device mobile Chrome, touch through the real input pipeline, notch/safe-area
rendering, and on-device service-worker/offline registration. So the emulator is
an **occasional on-device/offline smoke**, not a CI gate.

```bash
bash scripts/android-smoke.sh
```

It builds `dist`, serves it via `vite preview --host 0.0.0.0` on :5220, boots the
`notehaven` AVD headless, `adb reverse tcp:5220 tcp:5220`, opens
`http://localhost:5220` in mobile Chrome, captures
`reports/mobile-qa/android-<timestamp>.png`, reads a best-effort dumpsys/logcat
smoke signal, and tears everything down (Chrome stopped, forwards removed,
vite/emulator killed).

Env knobs: `ANDROID_HOME`/`ANDROID_SDK_ROOT`, `AVD_NAME` (default `notehaven`),
`SYSTEM_IMAGE`, `ANDROID_PREVIEW_PORT` (default `5220`), `KEEP_EMULATOR=1`,
`ANDROID_BOOT_TIMEOUT_S`.

**Prerequisites (any OS):** the Android SDK with `platform-tools` (adb), the
`emulator`, and **an existing AVD** (`AVD_NAME`). The script requires `adb` +
`emulator` + the AVD to exist; it does **not** need `sdkmanager`/`avdmanager`
those are only used to *create* an AVD beforehand, so on machines that already
have an AVD (e.g. `Pixel_3a_API_32_arm64-v8a` created by Android Studio) you can
run it directly. Verified on macOS with an existing arm64 AVD:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"     # macOS (or $HOME/Android/Sdk on Linux)
export AVD_NAME=Pixel_3a_API_32_arm64-v8a           # use one of your existing AVDs
bash scripts/android-smoke.sh
```

If you need to create an AVD first (the steps `sdkmanager`/`avdmanager` do):

```bash
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
sdkmanager --licenses
sdkmanager "platform-tools" "emulator" "platforms;android-34"
# Use a playstore image so Chrome is preinstalled — a plain `google_apis` image
# has NO browser, so the smoke boots fine but cannot render the app (it now
# detects this and fails with a clear message instead of a misleading success).
SYSTEM_IMAGE="system-images;android-34;google_apis_playstore;arm64-v8a"
sdkmanager "$SYSTEM_IMAGE"
echo no | avdmanager create avd -n "notehaven" -k "$SYSTEM_IMAGE" --device "pixel_7"
```

What it covers: real Chrome rendering + touch on a phone AVD, on-device
service-worker/offline (the SW only exists in `dist/`, so it uses `vite preview`,
same as `scripts/e2e-pwa.sh`), and notch/safe-area. It is a load/render smoke with
a screenshot — interactions stay in the Playwright suite. (Note: a Chrome
"first-run"/`FirstRunActivity` screen can appear on the first launch; the smoke
still resolves the intent, loads the page and captures the screenshot.)

## Pitfalls

- **`env()` is `0`/undefined in non-notched / headless environments.** Playwright
  and headless Chrome report `env(safe-area-inset-*)` as `0` (no notch, no
  insets), so a safe-area regression passes in CI and silently breaks on a real
  iPhone. That is exactly why safe-area and `100dvh` are validated **visually via
  the iOS-Simulator screenshot** (`scripts/ios-smoke.sh`), in real WebKit on a
  real notched device model.
- **`chromium-mobile` is intentionally scoped.** Its `testMatch:
  '**/*mobile*.spec.ts'` means desktop specs never run against the mobile
  viewport (mobile replaces the sidebar with a top sheet); keep mobile-focused
  specs `*mobile*.spec.ts`-named so they run in both projects.
- **`dist/` (and thus the service worker) is build-time only.** The PWA
  `sw.js` is only emitted by `vite build`, so offline/service-worker checks must
  attach to `vite preview` of `dist`, never `vite dev` — the iOS smoke builds and
  previews `dist` for this same reason (`scripts/e2e-pwa.sh` follows the same
  pattern for the desktop offline suite).
- **Simulator Safari automation is limited.** `xcrun simctl` can `openurl` and
  screenshot, but driving taps/scrolls programmatically is fragile and not
  supported — keep the iOS smoke a load/render smoke and lean on the Playwright
  suite for interactions.
- **Installability / stand-alone PWA is not exercised by this smoke** (only
  in-page load). Verifying install-to-home-screen behavior is out of scope for the
  automated paths here and best done as a manual pass on device.
