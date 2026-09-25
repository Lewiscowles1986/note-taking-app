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

/** Per-server OIDC blob: the server id (normalized URL) is the suffix. */
export function oidcKeyFor(serverId: string): string {
  return `notehaven.sync.oidc.${serverId}`;
}

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

function readBlob(key: string = OIDC_STORAGE_KEY): OidcBlob {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as OidcBlob;
  } catch {
    return {};
  }
}

function writeBlob(key: string, blob: OidcBlob): void {
  const hasContent = blob.config !== undefined || blob.session !== undefined;
  if (hasContent) {
    localStorage.setItem(key, JSON.stringify(blob));
  } else {
    localStorage.removeItem(key);
  }
}

/** Read the stored client config, filling missing fields with defaults. */
export function loadOidcConfig(): OidcClientConfig {
  return toConfig(readBlob().config);
}

/** Persist client config, preserving any stored session. */
export function saveOidcConfig(config: OidcClientConfig): void {
  writeBlob(OIDC_STORAGE_KEY, {
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
  return toSession(readBlob().session);
}

/** Persist the session, preserving the stored client config. */
export function saveOidcSession(session: OidcSession): void {
  writeBlob(OIDC_STORAGE_KEY, { config: readBlob().config, session });
}

/** Forget the session (keeps the client config so re-login is one click). */
export function clearOidcSession(): void {
  writeBlob(OIDC_STORAGE_KEY, { config: readBlob().config, session: undefined });
}

// ─── per-server variants (multi-server sync) ────────────────────────────────

function toSession(raw: unknown): OidcSession | null {
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

function toConfig(raw: unknown): OidcClientConfig {
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

/** Read the per-server client config, filling missing fields with defaults. */
export function loadOidcConfigFor(serverId: string): OidcClientConfig {
  return toConfig(readBlob(oidcKeyFor(serverId)).config);
}

/** Persist the per-server client config, preserving any stored session. */
export function saveOidcConfigFor(serverId: string, config: OidcClientConfig): void {
  writeBlob(oidcKeyFor(serverId), {
    config: {
      issuer: config.issuer.trim().replace(/\/+$/, ''),
      clientId: config.clientId,
      scope: config.scope,
    },
    session: readBlob(oidcKeyFor(serverId)).session,
  });
}

/** Read the per-server session (null when signed out or corrupt). */
export function loadOidcSessionFor(serverId: string): OidcSession | null {
  return toSession(readBlob(oidcKeyFor(serverId)).session);
}

/** Persist the per-server session, preserving the stored client config. */
export function saveOidcSessionFor(serverId: string, session: OidcSession): void {
  writeBlob(oidcKeyFor(serverId), { config: readBlob(oidcKeyFor(serverId)).config, session });
}

/** Forget the per-server session (keeps the client config). */
export function clearOidcSessionFor(serverId: string): void {
  writeBlob(oidcKeyFor(serverId), { config: readBlob(oidcKeyFor(serverId)).config, session: undefined });
}