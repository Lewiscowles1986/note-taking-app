/**
 * App-root PATH every spec navigates to: `page.goto(APP_PATH)`.
 *
 * Resolution order:
 *  1. E2E_BASE_PATH — explicit override (must start with "/").
 *  2. The path of E2E_BASE_URL in attach mode (the app is served at that URL,
 *     so its pathname is the app root — e.g. GitHub Pages project sites under
 *     /<repo>/).
 *  3. "/" (default mode: vite dev/preview at the origin root).
 *
 * Trailing slashes are stripped; the root stays "/". Playwright resolves an
 * absolute path like "/" against the ORIGIN root (new URL('/', base) drops the
 * base URL's path), so deployments under a sub-path must navigate to their
 * app-root path explicitly — that is what this constant is for.
 */
function normalizeBasePath(raw: string, envName: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(
      `Invalid ${envName} "${raw}" — must start with "/", e.g. /note-taking-app`,
    );
  }
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

export function resolveAppPath(): string {
  const override = process.env.E2E_BASE_PATH;
  if (override && override.trim() !== '') {
    return normalizeBasePath(override, 'E2E_BASE_PATH');
  }
  const attach = process.env.E2E_BASE_URL;
  if (attach && attach.trim() !== '') {
    try {
      return normalizeBasePath(new URL(attach.trim()).pathname, 'E2E_BASE_URL');
    } catch {
      // Invalid URL: playwright.config.ts throws a precise error for it before
      // tests load; fall back to "/" here rather than double-reporting.
      return '/';
    }
  }
  return '/';
}

export const APP_PATH = resolveAppPath();