/**
 * Build-time stub for src/lib/oidcAuth.ts — compiled in ONLY when
 * `VITE_NO_SYNC=1`. The OIDC client (PKCE + JWKS crypto) never enters a
 * no-sync bundle; the sign-in buttons in the settings/servers pages exist
 * there (they are part of the sync UI), and clicking one should say so
 * plainly instead of half-working.
 *
 * Self-contained on purpose: the real OidcError is defined in this module, so
 * the stub re-exports its own — consumers' `instanceof OidcError` checks keep
 * working against the stub's thrown errors.
 */

export const PENDING_KEY = 'notehaven.oidc.pending';
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const REFRESH_SKEW_MS = 60 * 1000;

export interface OidcPendingLogin {
  [key: string]: unknown;
}

export interface DiscoveredEndpoints {
  tokenEndpoint: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
}

export interface JwtPayload {
  [key: string]: unknown;
}

/** Same name as the real module's error so `instanceof` paths behave. */
export class OidcError extends Error {}

const DISABLED = 'Sign-in is disabled in this build (VITE_NO_SYNC)';

export class OidcAuthDisabledError extends OidcError {}

export async function discoverEndpoints(): Promise<DiscoveredEndpoints> {
  throw new OidcAuthDisabledError(DISABLED);
}

export async function pkceChallenge(): Promise<string> {
  throw new OidcAuthDisabledError(DISABLED);
}

export function generateCodeVerifier(): string {
  throw new OidcAuthDisabledError(DISABLED);
}

export interface LoginOptions {
  returnTo?: string;
  prompt?: 'login';
}

export async function login(): Promise<void> {
  throw new OidcAuthDisabledError(DISABLED);
}

export function buildRedirectUri(): string {
  throw new OidcAuthDisabledError(DISABLED);
}

export function decodeJwtPayload(): JwtPayload {
  throw new OidcAuthDisabledError(DISABLED);
}

export async function validateIdToken(): Promise<JwtPayload> {
  throw new OidcAuthDisabledError(DISABLED);
}

export async function completeLogin(): Promise<{ returnTo: string }> {
  throw new OidcAuthDisabledError(DISABLED);
}

export interface AccessTokenResult {
  [key: string]: unknown;
}

export async function getValidAccessToken(): Promise<string> {
  throw new OidcAuthDisabledError(DISABLED);
}

export async function refreshOrExpireSession(): Promise<string> {
  throw new OidcAuthDisabledError(DISABLED);
}

export async function logout(): Promise<void> {}

export async function getUserInfo(): Promise<JwtPayload | null> {
  return null;
}

export function currentConfig(): import('@/lib/oidcStorage').OidcClientConfig {
  throw new OidcAuthDisabledError(DISABLED);
}