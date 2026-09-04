import { defineConfig, devices } from '@playwright/test';

// Attach mode: when E2E_BASE_URL is set, tests attach to an already-running
// server at that URL and Playwright does NOT start its own webServer. When
// unset, Playwright boots vite on 5173 (default mode). The value must be an
// absolute http(s) URL; a trailing slash is tolerated and stripped.
let baseURL = 'http://localhost:5173';
if (process.env.E2E_BASE_URL) {
  const raw = process.env.E2E_BASE_URL.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid E2E_BASE_URL "${process.env.E2E_BASE_URL}" — expected an absolute http(s) URL, e.g. http://localhost:5199`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`E2E_BASE_URL must use http(s), got "${raw}"`);
  }
  baseURL = raw;
}
const attachMode = !!process.env.E2E_BASE_URL;

// Debug mode: E2E_DEBUG=1 (or "true") forces a single headed window, serial
// execution, and no retries so each test deterministically pauses at its
// labeled debugBreak before the assertion cluster.
const debugMode = process.env.E2E_DEBUG === '1' || process.env.E2E_DEBUG === 'true';

// No-screenshot mode: E2E_NO_SCREENSHOTS=1 (or "true") disables failure
// screenshots and traces (trace archives embed screenshots), and makes the
// step() helper in e2e/fixtures.ts a no-op, so a run leaves no image artifacts
// at all. Intended together with attach mode (E2E_BASE_URL) for runs against a
// remote server. The toHaveScreenshot baselines in app.spec.ts are unaffected
// (they are assertions, not artifacts); pass --ignore-snapshots to skip those
// too — npm run test:e2e:remote does exactly that.
const noScreenshots =
  process.env.E2E_NO_SCREENSHOTS === '1' || process.env.E2E_NO_SCREENSHOTS === 'true';

export default defineConfig({
  testDir: 'e2e',
  // Platform-independent snapshot baselines: the default template appends
  // {-platform} (e.g. -darwin on macOS, -linux on CI), which would make
  // committed baselines fail on any other OS. Omit the platform token so the
  // same file is used everywhere while {-projectname} keeps chromium vs
  // chromium-mobile baselines distinct.
  snapshotPathTemplate:
    '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: debugMode ? 0 : process.env.CI ? 2 : 1,
  workers: debugMode ? 1 : process.env.CI ? 1 : 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: noScreenshots ? 'off' : 'on-first-retry',
    screenshot: noScreenshots ? 'off' : 'only-on-failure',
    actionTimeout: 10000,
    // Debug mode must be headed so page.pause() opens the Inspector.
    headless: debugMode ? false : undefined,
    // Enable WebGL (three.js 3D models) under headless Chromium's SwiftShader.
    // Without these, THREE.WebGLRenderer throws "could not create a WebGL
    // context" and the Model3DBlock crashes the app.
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      },
    },
  ],
  // In attach mode (E2E_BASE_URL set) no server is started — tests attach to
  // the URL as-is. Otherwise Playwright boots vite on 5173 (strictPort).
  webServer: attachMode
    ? undefined
    : {
        command: 'npx vite --port 5173 --strictPort',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
      },
});
