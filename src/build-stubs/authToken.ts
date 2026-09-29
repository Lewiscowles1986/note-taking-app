/**
 * Build-time stub for src/lib/authToken.ts — compiled in ONLY when
 * `VITE_NO_SYNC=1`. The real module is the thin seam between the sync engine
 * and the OIDC session; in a no-sync build there is no session and no manual
 * token to resolve, so every request is unauthenticated (empty token).
 */

export async function resolveAuthToken(): Promise<string> {
  return '';
}