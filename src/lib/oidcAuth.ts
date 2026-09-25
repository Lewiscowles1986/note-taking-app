/**
 * OIDC Authorization Code + PKCE login for the reference sync server.
 *
 * Flow (browser redirect based — no popup):
 *   1. login()        — generate PKCE verifier/challenge + state/nonce, fetch
 *                       discovery, stash the pending request in sessionStorage,
 *                       navigate to the authorization endpoint.
 *   2. /auth/callback — AuthCallbackPage validates state, exchanges the code
 *                       (completeLogin), validates the id_token RS256 signature
 *                       against the issuer's JWKS + iss/aud/exp/nonce checks,
 *                       and stores the session (oidcStorage.ts).
 *   3. refresh        — getValidAccessToken() refreshes when within 60 s of
 *                       expiry; rotated refresh tokens persist; reuse of a
 *                       rotated token (invalid_grant) expires the session.
 *   4. logout()       — RFC 7009 revoke of access + refresh, then clear.
 *
 * Heavy by nature (WebCrypto, fetch, base64url) — imported lazily from
 * authToken.ts and the settings/callback pages so the eager bundle stays clean.
 *
 * Security notes (documented in docs/sync.md): tokens at rest in localStorage
 * is an accepted tradeoff for this reference client; the PKCE verifier lives
 * in sessionStorage for the duration of a single login only.
 */

import {
  loadOidcConfig,
  loadOidcSession,
  saveOidcSession,
  clearOidcSession,
  type OidcClientConfig,
  type OidcEndpoints,
  type OidcSession,
} from './oidcStorage';

/** sessionStorage key for the in-flight login (per-tab, survives redirect). */
export const PENDING_KEY = 'notehaven.oidc.pending';

/** How long a started login remains usable before it is abandoned (ms). */
export const PENDING_TTL_MS = 10 * 60 * 1000;

/** Refresh when the access token is this close to expiry (ms). */
export const REFRESH_SKEW_MS = 60 * 1000;

export interface OidcPendingLogin {
  verifier: string;
  state: string;
  nonce: string;
  issuedAt: number;
  redirectUri: string;
  /** Where to land after a successful login (e.g. "/" or "/?settings=1"). */
  returnTo: string;
  /** Endpoints resolved from discovery at login() time so the callback does
   * not need to fetch the discovery document again. */
  issuer: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface DiscoveredEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  /** Access-token hash (OIDC Core §3.1.3.6) when the issuer includes it. */
  at_hash?: string;
  preferred_username?: string;
  name?: string | null;
  email?: string | null;
  [claim: string]: unknown;
}

/** Error type carrying a user-facing message (never raw stack traces). */
export class OidcError extends Error {}

function requireIssuer(issuer: string): string {
  const base = issuer.trim().replace(/\/+$/, '');
  if (!base) throw new OidcError('No sign-in server configured');
  return base;
}

async function fetchJson(url: string, what: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (e) {
    throw new OidcError(`${what}: could not reach the server — ${e instanceof Error ? e.message : e}`);
  }
  if (!response.ok) {
    throw new OidcError(`${what}: server responded ${response.status}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new OidcError(`${what}: server returned invalid JSON`);
  }
}

/** Read the discovery document (/.well-known/openid-configuration). */
export async function discoverEndpoints(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredEndpoints> {
  const base = requireIssuer(issuer);
  const doc = (await fetchJson(
    `${base}/.well-known/openid-configuration`,
    'Reading sign-in configuration',
    fetchImpl,
  )) as Record<string, unknown>;
  const authorization = typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : '';
  const token = typeof doc.token_endpoint === 'string' ? doc.token_endpoint : '';
  const jwks = typeof doc.jwks_uri === 'string' ? doc.jwks_uri : '';
  if (!authorization || !token || !jwks) {
    throw new OidcError('Sign-in configuration is incomplete (missing endpoints)');
  }
  return {
    authorizationEndpoint: authorization,
    tokenEndpoint: token,
    jwksUri: jwks,
    revocationEndpoint: typeof doc.revocation_endpoint === 'string' ? doc.revocation_endpoint : undefined,
    userinfoEndpoint: typeof doc.userinfo_endpoint === 'string' ? doc.userinfo_endpoint : undefined,
  };
}

// ─── PKCE + random helpers ───────────────────────────────────────────────────

function randomB64url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 §4.1: base64url(SHA-256(ascii(verifier))). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 64 random bytes → 86-char base64url verifier (within RFC's 43–128). */
export function generateCodeVerifier(): string {
  return randomB64url(64);
}

// ─── login (step 1: redirect to the authorization endpoint) ─────────────────

export interface LoginOptions {
  /** Where to navigate after a successful round-trip. Default: "/". */
  returnTo?: string;
  /**
   * OIDC prompt parameter. 'login' forces the IdP to re-authenticate even
   * when an SSO session exists — used by "Use a different account" so the
   * user can nominate different credentials without clearing cookies.
   */
  prompt?: 'login' | 'none';
  fetchImpl?: typeof fetch;
}

/**
 * Begin a login: fetch discovery, persist the pending PKCE request in
 * sessionStorage and navigate the whole page to the authorization endpoint.
 * Resolves only when navigation was initiated (it "never returns" in practice —
 * the page unloads).
 */
export async function login(options: LoginOptions = {}): Promise<void> {
  const config = loadOidcConfig();
  const endpoints = await discoverEndpoints(config.issuer, options.fetchImpl ?? fetch);
  const redirectUri = buildRedirectUri();

  const verifier = generateCodeVerifier();
  const challenge = await pkceChallenge(verifier);
  const state = randomB64url(16);
  const nonce = randomB64url(16);

  const pending: OidcPendingLogin = {
    verifier,
    state,
    nonce,
    issuedAt: Date.now(),
    redirectUri,
    returnTo: options.returnTo ?? '/',
    issuer: config.issuer,
    tokenEndpoint: endpoints.tokenEndpoint,
    jwksUri: endpoints.jwksUri,
    revocationEndpoint: endpoints.revocationEndpoint,
    userinfoEndpoint: endpoints.userinfoEndpoint,
  };
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));

  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.prompt) {
    url.searchParams.set('prompt', options.prompt);
  }

  window.location.assign(url.toString());
}

/**
 * redirect_uri for this app instance: origin + Vite base path + /auth/callback.
 * Matches the server-registered http://localhost:4173/auth/callback in dev.
 */
export function buildRedirectUri(): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
  return `${window.location.origin}${base}/auth/callback`;
}

// ─── id_token validation ─────────────────────────────────────────────────────

function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** base64url (RFC 4648 §5, unpadded) — used for at_hash comparison. */
function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeJwtPayload(jwt: string): JwtPayload {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new OidcError('Malformed id_token');
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as JwtPayload;
  } catch {
    throw new OidcError('Malformed id_token payload');
  }
}

interface JwkSet {
  keys?: Array<Record<string, unknown>>;
}

/** Cached JWKS (module level) — avoids a fetch per token validation.
 * Invalidated (refetched) once when a token arrives with an unknown kid,
 * which is how issuers signal key rotation. */
let jwksCache: { uri: string; keys: Array<Record<string, unknown>> } | null = null;

async function getJwks(jwksUri: string, fetchImpl: typeof fetch, { forceRefresh = false } = {}): Promise<Array<Record<string, unknown>>> {
  if (!forceRefresh && jwksCache && jwksCache.uri === jwksUri) return jwksCache.keys;
  const jwks = (await fetchJson(jwksUri, 'Reading signing keys', fetchImpl)) as JwkSet;
  const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
  jwksCache = { uri: jwksUri, keys };
  return keys;
}

/** Fetch + cache the issuer's public keys for the length of the call. */
async function fetchJwks(jwksUri: string, fetchImpl: typeof fetch): Promise<Array<Record<string, unknown>>> {
  return getJwks(jwksUri, fetchImpl);
}

/**
 * Verify an RS256 JWT against a JWKS: signature via WebCrypto
 * (RSASSA-PKCS1-v1_5 / SHA-256, key imported from the matching `kid` JWK),
 * then iss/aud/exp checks. Throws OidcError with a user-facing message.
 */
export async function validateIdToken(
  idToken: string,
  params: {
    jwksUri: string;
    issuer: string;
    clientId: string;
    nonce: string;
    /** The access token issued alongside this id_token — used to verify
     * at_hash when the id_token carries one (OIDC Core §3.1.3.6). */
    accessToken?: string;
    now?: number;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<JwtPayload> {
  const headerB64 = idToken.split('.')[0];
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64))) as { alg?: string; kid?: string };
  } catch {
    throw new OidcError('Malformed id_token header');
  }
  if (header.alg !== 'RS256') {
    throw new OidcError('Unsupported id_token algorithm (expected RS256)');
  }

  const keys = await getJwks(params.jwksUri, fetchImpl);
  let key = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!key && header.kid) {
    // Unknown kid → the issuer likely rotated its signing keys. Refetch the
    // JWKS once (cache-bust) before failing.
    const refreshed = await getJwks(params.jwksUri, fetchImpl, { forceRefresh: true });
    key = refreshed.find((k) => k.kid === header.kid && k.kty === 'RSA');
  }
  if (!key) {
    throw new OidcError('No matching signing key for the id_token');
  }

  const signed = new TextEncoder().encode(`${idToken.split('.')[0]}.${idToken.split('.')[1]}`);
  const signature = b64urlDecode(idToken.split('.')[2]);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key as unknown as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signed);
  if (!valid) {
    throw new OidcError('id_token signature check failed');
  }

  const payload = decodeJwtPayload(idToken);
  if (payload.iss !== params.issuer) {
    throw new OidcError('id_token issuer mismatch');
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(params.clientId)) {
    throw new OidcError('id_token audience mismatch');
  }
  const now = params.now ?? Date.now();
  // ~60 s leeway for small clock skew between client and issuer.
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now - 60_000) {
    throw new OidcError('id_token has expired');
  }
  if (payload.nonce !== params.nonce) {
    throw new OidcError('id_token nonce mismatch');
  }
  // at_hash binds the id_token to the access token (OIDC Core §3.1.3.6):
  // base64url of the LEFT HALF of SHA-256 over the access_token's ASCII bytes.
  if (typeof payload.at_hash === 'string' && payload.at_hash) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.accessToken));
    const expected = new Uint8Array(digest).slice(0, 16);
    if (b64urlEncode(expected) !== payload.at_hash) {
      throw new OidcError('id_token at_hash mismatch (access token binding failed)');
    }
  }
  return payload;
}

// ─── token exchange ──────────────────────────────────────────────────────────

function tokenErrorFrom(
  body: { error?: unknown; error_description?: unknown },
  status: number,
  what: string,
): OidcError {
  const code = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
  const description = typeof body.error_description === 'string' ? body.error_description : '';
  if (code === 'invalid_grant') {
    // Covers both code-exchange failures and refresh reuse detection — the
    // session-expiry path in refreshOrExpireSession keys on this message.
    return new OidcError(`${what} rejected: ${description || 'the authorization grant is invalid'}`);
  }
  return new OidcError(`${what} failed (${code})${description ? ` — ${description}` : ''}`);
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
  what: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new OidcError(`${what}: could not reach the server — ${e instanceof Error ? e.message : e}`);
  }
  const text = await response.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON body — fall through to status handling */
  }
  if (!response.ok) throw tokenErrorFrom(body, response.status, what);
  return body;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * Consume the pending login (validating `state`), exchange the authorization
 * code at the token endpoint (PKCE, public client → auth 'none'), validate the
 * id_token (JWKS + iss/aud/exp/nonce) and persist the session. On success the
 * pending entry is removed; the caller should navigate to `pending.returnTo`.
 */
export async function completeLogin(params: URLSearchParams, fetchImpl: typeof fetch = fetch): Promise<{ returnTo: string }> {
  const rawPending = sessionStorage.getItem(PENDING_KEY);
  if (params.get('error')) {
    sessionStorage.removeItem(PENDING_KEY);
    throw new OidcError(`Sign-in failed: ${params.get('error_description') || params.get('error')}`);
  }
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  if (!code) {
    sessionStorage.removeItem(PENDING_KEY);
    throw new OidcError('Sign-in response did not include an authorization code');
  }
  if (!rawPending) {
    throw new OidcError('No sign-in in progress — start again from Settings');
  }
  let pending: OidcPendingLogin;
  try {
    pending = JSON.parse(rawPending) as OidcPendingLogin;
  } catch {
    sessionStorage.removeItem(PENDING_KEY);
    throw new OidcError('Stored sign-in request was corrupt — start again');
  }
  if (Date.now() - pending.issuedAt > PENDING_TTL_MS) {
    sessionStorage.removeItem(PENDING_KEY);
    throw new OidcError('Sign-in request expired — start again');
  }
  if (state !== pending.state) {
    // Possible CSRF — do not consume the pending entry destructively beyond
    // dropping it; never exchange the code.
    sessionStorage.removeItem(PENDING_KEY);
    throw new OidcError('Sign-in state check failed — start again');
  }

  const config = loadOidcConfig();
  const body = (await postForm(
    pending.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      client_id: config.clientId,
    },
    'Exchanging the authorization code',
    fetchImpl,
  )) as RawTokenResponse;

  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : null;
  const idToken = typeof body.id_token === 'string' ? body.id_token : null;
  const scope = typeof body.scope === 'string' ? body.scope : config.scope;
  if (!accessToken) throw new OidcError('Token response did not include an access token');
  if (!idToken) throw new OidcError('Token response did not include an id_token');

  const payload = await validateIdToken(
    idToken,
    {
      jwksUri: pending.jwksUri,
      issuer: pending.issuer,
      clientId: config.clientId,
      nonce: pending.nonce,
      accessToken,
    },
    fetchImpl,
  );

  const session: OidcSession = {
    clientId: config.clientId,
    accessToken,
    refreshToken,
    idToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
    claims: {
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      preferred_username: typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
      name: payload.name ?? null,
      email: payload.email ?? null,
    },
    endpoints: {
      tokenEndpoint: pending.tokenEndpoint,
      revocationEndpoint: pending.revocationEndpoint,
      userinfoEndpoint: pending.userinfoEndpoint,
    },
  };
  saveOidcSession(session);
  sessionStorage.removeItem(PENDING_KEY);
  return { returnTo: pending.returnTo || '/' };
}

// ─── refresh flow ────────────────────────────────────────────────────────────

export interface AccessTokenResult {
  token: string;
  session: OidcSession;
}

/**
 * In-flight refresh dedup. Concurrent callers (e.g. the sync engine and a
 * background scheduler tick) must share ONE refresh request: the reference
 * server rotates refresh tokens and revokes the whole family on reuse, so a
 * second parallel refresh would invalidate the first caller's rotation and
 * log the user out.
 */
let refreshInFlight: Promise<string> | null = null;

/**
 * Return a usable access token, refreshing (and persisting the rotation) when
 * the stored one is within REFRESH_SKEW_MS of expiry. If the refresh token was
 * rotated-and-reused (invalid_grant → family revoked server-side), the session
 * is expired locally and OidcError is thrown — the caller must re-login.
 */
export async function getValidAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  const session = loadOidcSession();
  if (!session) throw new OidcError('Not signed in');
  if (session.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return session.accessToken; // still fresh
  }
  // A refresh is already running: join it instead of racing a second one.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh(fetchImpl);
  try {
    return await refreshInFlight;
  } finally {
    // On failure the shared promise is dropped so the NEXT caller can retry
    // (e.g. after a transient network error). On success it is also dropped:
    // the session is now fresh and further callers take the fast path.
    refreshInFlight = null;
  }
}

/** The actual refresh POST — single-flight, only reached via
 * getValidAccessToken's dedup wrapper. */
async function performRefresh(fetchImpl: typeof fetch): Promise<string> {
  const session = loadOidcSession();
  if (!session) throw new OidcError('Not signed in');
  if (!session.refreshToken) {
    clearOidcSession();
    throw new OidcError('Session expired — sign in again');
  }
  if (!session.endpoints?.tokenEndpoint) {
    clearOidcSession();
    throw new OidcError('Session is missing its token endpoint — sign in again');
  }
  let body: RawTokenResponse;
  try {
    body = (await postForm(
      session.endpoints.tokenEndpoint,
      {
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: session.clientId,
      },
      'Refreshing the session',
      fetchImpl,
    )) as RawTokenResponse;
  } catch (e) {
    // invalid_grant on refresh = rotated token reused → family revoked
    // server-side. Expire the session locally so the UI asks for a re-login.
    if (e instanceof OidcError && /invalid_grant|rejected/i.test(e.message)) {
      clearOidcSession();
      throw new OidcError('Your session has expired — please sign in again');
    }
    throw e;
  }

  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  if (!accessToken) {
    clearOidcSession();
    throw new OidcError('Refresh response did not include an access token');
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  // Rotation: persist the NEW refresh token. The old one is dead server-side.
  const nextRefresh = typeof body.refresh_token === 'string' ? body.refresh_token : session.refreshToken;
  const next: OidcSession = {
    ...session,
    accessToken,
    refreshToken: nextRefresh,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: typeof body.scope === 'string' ? body.scope : session.scope,
  };
  saveOidcSession(next);
  return accessToken;
}

/**
 * Refresh with reuse handling already built in (getValidAccessToken expires
 * the session on invalid_grant). Kept as a named seam for callers that want
 * the explicit semantics.
 */
export async function refreshOrExpireSession(fetchImpl: typeof fetch = fetch): Promise<string> {
  return getValidAccessToken(fetchImpl);
}

// ─── logout (RFC 7009 revocation) ────────────────────────────────────────────

/**
 * Revoke the access and refresh tokens at the revocation endpoint (when the
 * issuer advertises one) and clear the stored session. Best-effort: network
 * failures still clear local state.
 */
export async function logout(fetchImpl: typeof fetch = fetch): Promise<void> {
  const session = loadOidcSession();
  if (session?.endpoints?.revocationEndpoint) {
    const tokens = [session.accessToken, session.refreshToken].filter((t): t is string => !!t);
    for (const token of tokens) {
      await postForm(
        session.endpoints.revocationEndpoint,
        { token, client_id: session.clientId },
        'Signing out',
        fetchImpl,
      ).catch(() => undefined); // RFC 7009: clear locally regardless
    }
  }
  clearOidcSession();
}

/** Fetch the userinfo claims with the current access token (refreshes first). */
export async function getUserInfo(
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const session = loadOidcSession();
  if (!session?.endpoints?.userinfoEndpoint) return null;
  const token = await getValidAccessToken(fetchImpl);
  let response: Response;
  try {
    response = await fetchImpl(session.endpoints.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Convenience: the stored config as endpoints-bearing object for callers. */
export function currentConfig(): OidcClientConfig {
  return loadOidcConfig();
}