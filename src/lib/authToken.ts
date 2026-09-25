/**
 * Auth token resolution — the thin seam between the sync engine and the OIDC
 * session. sync.ts imports ONLY this module: it stays ignorant of OIDC
 * internals, and this module stays tiny enough for the eager chunk (it only
 * touches localStorage synchronously and lazy-imports the heavy OIDC engine
 * when a refresh is actually needed).
 *
 * Multi-server: the server id (normalized URL) is explicit — each configured
 * server has its own OIDC session and its own manual token. Resolution order
 * per server:
 *   1. That server's OIDC session exists → its access token (refreshing via
 *      the lazy oidcAuth module when it is within 60 s of expiry — works from
 *      background scheduler ticks because the resolver is async).
 *   2. Otherwise                         → that server's manual bearer token
 *      (the "Advanced" field for servers without OIDC).
 *   3. Neither                           → '' (unauthenticated requests).
 */

import { loadOidcSessionFor } from './oidcStorage';

/** Cache of the lazy oidcAuth module — avoids repeated dynamic imports. */
let oidcAuthModule: typeof import('./oidcAuth') | null = null;

async function loadOidcAuth(): Promise<typeof import('./oidcAuth')> {
  if (!oidcAuthModule) {
    oidcAuthModule = await import('./oidcAuth');
  }
  return oidcAuthModule;
}

/**
 * Resolve the bearer token for ONE server's outgoing sync/API request. Never
 * throws — a failing OIDC refresh yields that server's manual token (or ''),
 * and the sync run surfaces the server's 401 instead of a resolver crash.
 */
export async function resolveAuthToken(
  serverId: string,
  manualToken: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const session = loadOidcSessionFor(serverId);
  if (!session) return manualToken;
  try {
    const oidc = await loadOidcAuth();
    return await oidc.getValidAccessToken(serverId, fetchImpl);
  } catch {
    // Refresh failed (network, reuse-revoked family, expired session). The
    // stored (possibly stale) access token is still the best available guess;
    // if the server rejects it the sync reports the 401 and the servers page
    // shows the signed-out state.
    return loadOidcSessionFor(serverId)?.accessToken ?? manualToken;
  }
}