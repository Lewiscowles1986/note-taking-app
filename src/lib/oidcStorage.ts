/**
 * localStorage accessors for OIDC client state.
 *
 * Deliberately dependency-free and tiny: it is imported eagerly by the token
 * resolver (authToken.ts) and the settings page, which must NOT pull in the
 * crypto/JWKS machinery of oidcAuth.ts. Storage keys mirror the engine by
 * convention — see docs/sync.md, "Storage layout on the client".
 *
 * One blob under `notehaven.sync.oidc` holds both the client configuration and
 * the current session:
 *
 *   { config:  { issuer, clientId, scope },          // which server/client
 *     session: { accessToken, refreshToken, … } }    // null when signed out
 *
 * Tokens at rest in localStorage is a documented tradeoff for this reference
 * client (XSS exposure vs. no backend session store) — see docs/sync.md.
 * The PKCE pending request lives in sessionStorage instead (per-login,
 * survives the redirect, dies with the tab): see oidcAuth.ts.
 */

export const OIDC_STORAGE_KEY = 'notehaven.sync.oidc';

/** Sensible defaults for the reference server (see server/README.md). */
export const DEFAULT_CLIENT_CONFIG: OidcClientConfig = {
  issuer: 'http://localhost:8080',
  clientId: 'note-haven-pkce',
  scope: 'openid profile offline_access notes.sync',
};

export interface OidcClientConfig {
  /** OIDC issuer base URL, e.g. "http://localhost:8080" (no trailing slash). */
  issuer: string;
  /** Public (PKCE-only) OAuth client id registered at the issuer. */
  clientId: string;
  /** Space-separated scopes to request. */
  scope: string;
}

export interface OidcEndpoints {
  tokenEndpoint: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface OidcIdClaims {
  sub?: string;
  preferred_username?: string;
  name?: string | null;
  email?: string | null;
}

export interface OidcSession {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch ms after which the access token is considered expired. */
  expiresAt: number;
  scope: string;
  /** Display claims copied from the validated id_token. */
  claims: OidcIdClaims;
  endpoints: OidcEndpoints;
}

interface OidcBlob {
  config?: unknown;
  session?: unknown;
}

function readBlob(): OidcBlob {
  try {
    const raw = localStorage.getItem(OIDC_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as OidcBlob;
  } catch {
    return {};
  }
}

function writeBlob(blob: OidcBlob): void {
  const hasContent = blob.config !== undefined || blob.session !== undefined;
  if (hasContent) {
    localStorage.setItem(OIDC_STORAGE_KEY, JSON.stringify(blob));
  } else {
    localStorage.removeItem(OIDC_STORAGE_KEY);
  }
}

/** Read the stored client config, filling missing fields with defaults. */
export function loadOidcConfig(): OidcClientConfig {
  const raw = readBlob().config;
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    issuer:
      typeof obj.issuer === 'string' && obj.issuer
        ? obj.issuer.trim().replace(/\/+$/, '')
        : DEFAULT_CLIENT_CONFIG.issuer,
    clientId:
      typeof obj.clientId === 'string' && obj.clientId
        ? obj.clientId
        : DEFAULT_CLIENT_CONFIG.clientId,
    scope:
      typeof obj.scope === 'string' && obj.scope
        ? obj.scope
        : DEFAULT_CLIENT_CONFIG.scope,
  };
}

/** Persist client config, preserving any stored session. */
export function saveOidcConfig(config: OidcClientConfig): void {
  writeBlob({
    config: {
      issuer: config.issuer.trim().replace(/\/+$/, ''),
      clientId: config.clientId,
      scope: config.scope,
    },
    session: readBlob().session,
  });
}

/**
 * Read the stored session, tolerating corrupt/partial storage. Returns null
 * unless the blob holds a minimally valid session.
 */
export function loadOidcSession(): OidcSession | null {
  const raw = readBlob().session;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Partial<OidcSession>;
  if (typeof s.accessToken !== 'string' || !s.accessToken) return null;
  if (typeof s.expiresAt !== 'number' || !Number.isFinite(s.expiresAt)) return null;
  return {
    clientId: typeof s.clientId === 'string' ? s.clientId : '',
    accessToken: s.accessToken,
    refreshToken: typeof s.refreshToken === 'string' ? s.refreshToken : null,
    idToken: typeof s.idToken === 'string' ? s.idToken : null,
    expiresAt: s.expiresAt,
    scope: typeof s.scope === 'string' ? s.scope : '',
    claims: (s.claims && typeof s.claims === 'object' ? s.claims : {}) as OidcSession['claims'],
    endpoints: (s.endpoints && typeof s.endpoints === 'object' ? s.endpoints : {}) as OidcSession['endpoints'],
  };
}

/** Persist the session, preserving the stored client config. */
export function saveOidcSession(session: OidcSession): void {
  writeBlob({ config: readBlob().config, session });
}

/** Forget the session (keeps the client config so re-login is one click). */
export function clearOidcSession(): void {
  writeBlob({ config: readBlob().config, session: undefined });
}

/** Cheap synchronous check used by the token resolver's fast path. */
export function isOidcActive(): boolean {
  return loadOidcSession() !== null;
}