/**
 * Unit tests for the OIDC auth module (src/lib/oidcAuth.ts).
 *
 * Covers: PKCE verifier/challenge generation, authorize URL building, state
 * validation (mismatch/absent/expired pending), the token exchange against a
 * fetch stub, id_token validation with a real RSA keypair + JWKS served by the
 * stub (positive AND negative: bad signature, wrong nonce, expired, wrong
 * aud/iss), the refresh flow (rotation persistence + reuse → session expiry),
 * and RFC 7009 revocation on logout.
 *
 * WebCrypto: Node's webcrypto (wired in by src/test/setup.ts) provides
 * crypto.subtle, so RS256 signing/verification runs for real in tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  discoverEndpoints,
  login,
  completeLogin,
  getValidAccessToken,
  logout,
  pkceChallenge,
  generateCodeVerifier,
  validateIdToken,
  decodeJwtPayload,
  buildRedirectUri,
  PENDING_KEY,
  PENDING_TTL_MS,
  OidcError,
} from '@/lib/oidcAuth';
import {
  clearOidcSession,
  loadOidcConfig,
  loadOidcSession,
  saveOidcConfig,
  saveOidcSession,
} from '@/lib/oidcStorage';

const { subtle } = webcrypto;

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'test-client';

// ─── RSA test keypair + JWT helpers ──────────────────────────────────────────

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid?: string };

const b64url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let bin = '';
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function b64urlDecodeToString(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return atob(input.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  saveOidcConfig({ issuer: ISSUER, clientId: CLIENT_ID, scope: 'openid profile offline_access notes.sync' });
  if (!keyPair) {
    keyPair = (await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    publicJwk = (await subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & { kid?: string };
    publicJwk.kid = 'test-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
  }
});

interface JwtOverrides {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  preferred_username?: string;
  alg?: string;
  kid?: string;
  key?: CryptoKey;
}

async function signIdToken(overrides: JwtOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: overrides.alg ?? 'RS256', kid: overrides.kid ?? 'test-kid' };
  const payload = {
    iss: overrides.iss ?? ISSUER,
    sub: overrides.sub ?? 'user-1',
    aud: overrides.aud ?? CLIENT_ID,
    iat: now,
    exp: overrides.exp ?? now + 3600,
    nonce: overrides.nonce ?? 'nonce-123',
    preferred_username: overrides.preferred_username ?? 'alice',
  };
  const enc = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = overrides.key ?? keyPair.privateKey;
  const sig = await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

// ─── fetch stub ──────────────────────────────────────────────────────────────

type Handler = (url: string, body: string, headers: Record<string, string>) => Response | Promise<Response>;

function makeFetch(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({ url, body, headers });
    const handler = Object.entries(handlers).find(([prefix]) => url.includes(prefix));
    if (!handler) throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return handler[1](url, body, headers);
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

function discoveryHandler(): Handler {
  return () =>
    Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      revocation_endpoint: `${ISSUER}/revoke`,
      jwks_uri: `${ISSUER}/jwks.json`,
    });
}

function jwksHandler(): Handler {
  return () => Response.json({ keys: [publicJwk] });
}

/** Wire a full happy-path exchange: returns the token body the stub will serve. */
function tokenHandler(tokenBody: Record<string, unknown>): { handler: Handler; bodies: Array<Record<string, string>> } {
  const bodies: Array<Record<string, string>> = [];
  return {
    bodies,
    handler: (_url, body) => {
      bodies.push(Object.fromEntries(new URLSearchParams(body)));
      return Response.json(tokenBody);
    },
  };
}

function successfulTokenBody(idToken: string): Record<string, unknown> {
  return {
    access_token: 'at-123',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'rt-123',
    id_token: idToken,
    scope: 'openid profile offline_access notes.sync',
  };
}

function seedPending(overrides: Partial<Record<string, unknown>> = {}): void {
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      verifier: 'v'.repeat(64),
      state: 'state-123',
      nonce: 'nonce-123',
      issuedAt: Date.now(),
      redirectUri: 'http://localhost:3000/auth/callback',
      returnTo: '/',
      issuer: ISSUER,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks.json`,
      revocationEndpoint: `${ISSUER}/revoke`,
      userinfoEndpoint: `${ISSUER}/userinfo`,
      ...overrides,
    }),
  );
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

describe('PKCE helpers', () => {
  it('generates 43–128 char verifiers from the RFC 7636 unreserved set', () => {
    for (let i = 0; i < 20; i++) {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it('verifiers are unique across calls', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    expect(set.size).toBe(50);
  });

  it('computes the S256 challenge as base64url(SHA-256(verifier))', async () => {
    // RFC 7636 appendix B vector.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await pkceChallenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

// ─── discovery ───────────────────────────────────────────────────────────────

describe('discoverEndpoints', () => {
  it('reads the discovery document and returns the endpoints', async () => {
    const { impl, calls } = makeFetch({ '.well-known/openid-configuration': discoveryHandler() });
    const endpoints = await discoverEndpoints(ISSUER, impl);
    expect(endpoints.authorizationEndpoint).toBe(`${ISSUER}/authorize`);
    expect(endpoints.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(endpoints.jwksUri).toBe(`${ISSUER}/jwks.json`);
    expect(endpoints.revocationEndpoint).toBe(`${ISSUER}/revoke`);
    expect(calls[0].url).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('normalizes the issuer (trailing slash) and rejects incomplete documents', async () => {
    const { impl } = makeFetch({
      '.well-known/openid-configuration': () => Response.json({ authorization_endpoint: `${ISSUER}/authorize` }),
    });
    await expect(discoverEndpoints(`${ISSUER}/`, impl)).rejects.toThrow(OidcError);
  });

  it('wraps network errors', async () => {
    const impl = (async (): Response => {
      throw new TypeError('down');
    }) as unknown as typeof fetch;
    await expect(discoverEndpoints(ISSUER, impl)).rejects.toThrow(/could not reach the server/);
  });
});

// ─── login() ─────────────────────────────────────────────────────────────────

describe('login', () => {
  it('stores a pending request and navigates to the authorization endpoint', async () => {
    const { impl } = makeFetch({ '.well-known/openid-configuration': discoveryHandler() });

    // jsdom cannot actually navigate — stub window.location via vi.stubGlobal.
    const targets: string[] = [];
    const locationStub = {
      ...window.location,
      assign: (url: string) => {
        targets.push(url);
      },
    };
    vi.stubGlobal('location', locationStub);
    try {
      await login({ returnTo: '/?settings=1', fetchImpl: impl });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(targets).toHaveLength(1);
    const url = new URL(targets[0]);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile offline_access notes.sync');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');

    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY)!) as Record<string, unknown>;
    expect(pending.state).toBe(url.searchParams.get('state'));
    expect(pending.nonce).toBe(url.searchParams.get('nonce'));
    expect(pending.returnTo).toBe('/?settings=1');
    expect(pending.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(pending.jwksUri).toBe(`${ISSUER}/jwks.json`);
    // Verifier matches its challenge (S256).
    const challenge = await pkceChallenge(String(pending.verifier));
    expect(challenge).toBe(url.searchParams.get('code_challenge'));
  });

  it('surfaces discovery failures as login errors (no navigation, pending cleared)', async () => {
    const impl = (async (): Response => {
      throw new TypeError('down');
    }) as unknown as typeof fetch;
    await expect(login({ fetchImpl: impl })).rejects.toThrow(OidcError);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

// ─── completeLogin (callback) ────────────────────────────────────────────────

describe('completeLogin', () => {
  it('rejects when no pending login exists', async () => {
    await expect(
      completeLogin(new URLSearchParams('code=c&state=s'), makeFetch().impl),
    ).rejects.toThrow(/No sign-in in progress/);
  });

  it('rejects a state mismatch and does not exchange the code', async () => {
    seedPending();
    const { impl, calls } = makeFetch({ '/token': () => Response.json({}) });
    await expect(
      completeLogin(new URLSearchParams('code=c&state=WRONG'), impl),
    ).rejects.toThrow(/state check failed/);
    expect(calls).toHaveLength(0);
  });

  it('rejects an expired pending request', async () => {
    seedPending({ issuedAt: Date.now() - PENDING_TTL_MS - 1000 });
    await expect(
      completeLogin(new URLSearchParams('code=c&state=state-123'), makeFetch().impl),
    ).rejects.toThrow(/expired/);
  });

  it('surfaces the OAuth error response', async () => {
    seedPending();
    await expect(
      completeLogin(new URLSearchParams('error=access_denied&error_description=nope'), makeFetch().impl),
    ).rejects.toThrow(/Sign-in failed: nope/);
  });

  it('exchanges the code, validates the id_token and stores the session', async () => {
    seedPending();
    const idToken = await signIdToken({ nonce: 'nonce-123' });
    const { handler, bodies } = tokenHandler(successBody(idToken));
    const { impl } = makeFetch({
      '/token': handler,
      '/jwks.json': jwksHandler(),
    });

    const { returnTo } = await completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl);
    expect(returnTo).toBe('/');

    // Token request: urlencoded, PKCE verifier, public client (no secret).
    expect(bodies).toHaveLength(1);
    expect(bodies[0].grant_type).toBe('authorization_code');
    expect(bodies[0].code).toBe('the-code');
    expect(bodies[0].redirect_uri).toBe('http://localhost:3000/auth/callback');
    expect(bodies[0].code_verifier).toBe('v'.repeat(64));
    expect(bodies[0].client_id).toBe(CLIENT_ID);
    expect(bodies[0].client_secret).toBeUndefined();

    // Session persisted with claims from the validated id_token.
    const session = loadOidcSession();
    expect(session).not.toBeNull();
    expect(session!.accessToken).toBe('at-123');
    expect(session!.refreshToken).toBe('rt-123');
    expect(session!.idToken).toBe(idToken);
    expect(session!.claims.preferred_username).toBe('alice');
    expect(session!.endpoints.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(session!.endpoints.revocationEndpoint).toBe(`${ISSUER}/revoke`);
    // Pending entry consumed.
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('rejects a bad PKCE result (invalid_grant) with a readable error', async () => {
    seedPending();
    const { impl } = makeFetch({
      '/token': () =>
        Response.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 }),
    });
    await expect(
      completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl),
    ).rejects.toThrow(/PKCE verification failed/);
  });

  it('rejects an id_token with a bad signature', async () => {
    seedPending();
    const idToken = await signIdToken({ nonce: 'nonce-123' });
    // Tamper with the signature.
    const parts = idToken.split('.');
    const bad = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -4)}AAAA`;
    const { impl } = makeFetch({
      '/token': () => Response.json(successBody(bad)),
      '/jwks.json': jwksHandler(),
    });
    await expect(
      completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl),
    ).rejects.toThrow(/signature check failed/);
  });

  it('rejects an id_token with the wrong nonce', async () => {
    seedPending();
    const idToken = await signIdToken({ nonce: 'attacker-nonce' });
    const { impl } = makeFetch({
      '/token': () => Response.json(successBody(idToken)),
      '/jwks.json': jwksHandler(),
    });
    await expect(
      completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it('rejects an id_token with the wrong audience', async () => {
    seedPending();
    const idToken = await signIdToken({ nonce: 'nonce-123', aud: 'other-client' });
    const { impl } = makeFetch({
      '/token': () => Response.json(successBody(idToken)),
      '/jwks.json': jwksHandler(),
    });
    await expect(
      completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl),
    ).rejects.toThrow(/audience mismatch/);
  });

  it('rejects an expired id_token', async () => {
    seedPending();
    const idToken = await signIdToken({ nonce: 'nonce-123', exp: Math.floor(Date.now() / 1000) - 100 });
    const { impl } = makeFetch({
      '/token': () => Response.json(successBody(idToken)),
      '/jwks.json': jwksHandler(),
    });
    await expect(
      completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl),
    ).rejects.toThrow(/expired/);
  });

  it('rejects an id_token from the wrong issuer', async () => {
    seedPending();
    const idToken = await signIdToken({ nonce: 'nonce-123', iss: 'https://evil.example' });
    const { impl } = makeFetch({
      '/token': () => Response.json(successBody(idToken)),
      '/jwks.json': jwksHandler(),
    });
    await expect(
      completeLogin(new URLSearchParams('code=the-code&state=state-123'), impl),
    ).rejects.toThrow(/issuer mismatch/);
  });
});

function successBody(idToken: string): Record<string, unknown> {
  return {
    access_token: 'at-123',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'rt-123',
    id_token: idToken,
    scope: 'openid profile offline_access notes.sync',
  };
}

// ─── validateIdToken / decodeJwtPayload ─────────────────────────────────────

describe('validateIdToken', () => {
  it('verifies a well-formed RS256 token and returns its claims', async () => {
    const token = await signIdToken({ nonce: 'n-1' });
    const payload = await validateIdToken(
      token,
      { jwksUri: `${ISSUER}/jwks.json`, issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n-1' },
      makeFetch({ '/jwks.json': jwksHandler() }).impl,
    );
    expect(payload.sub).toBe('user-1');
    expect(payload.preferred_username).toBe('alice');
  });

  it('rejects a token signed by a different key', async () => {
    const otherPair = (await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const token = await signIdToken({ nonce: 'n-1', key: otherPair.privateKey });
    await expect(
      validateIdToken(
        token,
        { jwksUri: `${ISSUER}/jwks.json`, issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n-1' },
        makeFetch({ '/jwks.json': jwksHandler() }).impl,
      ),
    ).rejects.toThrow(/signature check failed/);
  });

  it('rejects non-RS256 algorithms (alg confusion)', async () => {
    const token = await signIdToken({ nonce: 'n-1', alg: 'none' });
    await expect(
      validateIdToken(
        token,
        { jwksUri: `${ISSUER}/jwks.json`, issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n-1' },
        makeFetch().impl,
      ),
    ).rejects.toThrow(/Unsupported id_token algorithm/);
  });

  it('rejects when no matching JWK exists', async () => {
    const token = await signIdToken({ nonce: 'n-1', kid: 'unknown-kid' });
    const { impl } = makeFetch({ '/jwks.json': () => Response.json({ keys: [] }) });
    await expect(
      validateIdToken(
        token,
        { jwksUri: `${ISSUER}/jwks.json`, issuer: ISSUER, clientId: CLIENT_ID, nonce: 'n-1' },
        impl,
      ),
    ).rejects.toThrow(/No matching signing key/);
  });
});

describe('decodeJwtPayload', () => {
  it('decodes a payload and rejects malformed tokens', () => {
    const token = `a.${btoa(JSON.stringify({ sub: 'x' }))}.s`;
    expect(decodeJwtPayload(token).sub).toBe('x');
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow(OidcError);
    expect(() => decodeJwtPayload('a.@#$.s')).toThrow(OidcError);
  });

  it('base64url-decoding helpers agree', () => {
    expect(b64urlDecodeToString('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBeTruthy();
  });
});

// ─── refresh flow ────────────────────────────────────────────────────────────

describe('getValidAccessToken', () => {
  it('returns the stored token while it is fresh (no network)', async () => {
    saveOidcSession({
      clientId: CLIENT_ID,
      accessToken: 'fresh-token',
      refreshToken: 'rt',
      idToken: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
      scope: 'openid',
      claims: {},
      endpoints: { tokenEndpoint: `${ISSUER}/token` },
    });
    const { impl, calls } = makeFetch();
    await expect(getValidAccessToken(impl)).resolves.toBe('fresh-token');
    expect(calls).toHaveLength(0);
  });

  it('refreshes when within 60s of expiry and persists the rotation', async () => {
    saveOidcSession({
      clientId: CLIENT_ID,
      accessToken: 'stale-token',
      refreshToken: 'rt-old',
      idToken: null,
      expiresAt: Date.now() + 30 * 1000, // within the 60s skew → refresh
      scope: 'openid',
      claims: {},
      endpoints: { tokenEndpoint: `${ISSUER}/token` },
    });
    const { handler, bodies } = tokenHandler({
      access_token: 'at-new',
      expires_in: 3600,
      refresh_token: 'rt-new',
      scope: 'openid',
    });
    const { impl } = makeFetch({ '/token': handler });

    await expect(getValidAccessToken(impl)).resolves.toBe('at-new');
    expect(bodies[0].grant_type).toBe('refresh_token');
    expect(bodies[0].refresh_token).toBe('rt-old');
    expect(bodies[0].client_id).toBe(CLIENT_ID);

    const session = loadOidcSession();
    expect(session!.accessToken).toBe('at-new');
    expect(session!.refreshToken).toBe('rt-new'); // rotation persisted
    expect(session!.expiresAt).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });

  it('expires the session on refresh-token reuse (invalid_grant)', async () => {
    saveOidcSession({
      clientId: CLIENT_ID,
      accessToken: 'stale',
      refreshToken: 'rt-reused',
      idToken: null,
      expiresAt: Date.now() + 30 * 1000,
      scope: 'openid',
      claims: {},
      endpoints: { tokenEndpoint: `${ISSUER}/token` },
    });
    const { impl } = makeFetch({
      '/token': () =>
        Response.json(
          { error: 'invalid_grant', error_description: 'refresh token reuse detected; token family revoked' },
          { status: 400 },
        ),
    });
    await expect(getValidAccessToken(impl)).rejects.toThrow(/session has expired/);
    expect(loadOidcSession()).toBeNull(); // cleared → UI shows signed-out
  });

  it('expires the session when no refresh token exists', async () => {
    saveOidcSession({
      clientId: CLIENT_ID,
      accessToken: 'stale',
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 30 * 1000,
      scope: 'openid',
      claims: {},
      endpoints: { tokenEndpoint: `${ISSUER}/token` },
    });
    await expect(getValidAccessToken(makeFetch().impl)).rejects.toThrow(/Session expired/);
    expect(loadOidcSession()).toBeNull();
  });

  it('throws (without clearing) when not signed in', async () => {
    await expect(getValidAccessToken(makeFetch().impl)).rejects.toThrow(/Not signed in/);
  });
});

// ─── logout (RFC 7009) ───────────────────────────────────────────────────────

describe('logout', () => {
  it('revokes access + refresh tokens and clears the session', async () => {
    saveOidcSession({
      clientId: CLIENT_ID,
      accessToken: 'at-revoke',
      refreshToken: 'rt-revoke',
      idToken: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
      scope: 'openid',
      claims: {},
      endpoints: { tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` },
    });
    const bodies: Array<Record<string, string>> = [];
    const { impl } = makeFetch({
      '/revoke': (_url, body) => {
        bodies.push(Object.fromEntries(new URLSearchParams(body)));
        return new Response('', { status: 200 });
      },
    });

    await logout(impl);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].token).toBe('at-revoke');
    expect(bodies[0].client_id).toBe(CLIENT_ID);
    expect(bodies[1].token).toBe('rt-revoke');
    expect(loadOidcSession()).toBeNull();
    // Client config survives so re-login is one click.
    expect(loadOidcConfig().clientId).toBeTruthy();
  });

  it('clears locally even when the revoke call fails', async () => {
    saveOidcSession({
      clientId: CLIENT_ID,
      accessToken: 'at-x',
      refreshToken: null,
      idToken: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
      scope: 'openid',
      claims: {},
      endpoints: { tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` },
    });
    const { impl } = makeFetch({
      '/revoke': () => {
        throw new TypeError('network down');
      },
    });
    await logout(impl);
    expect(loadOidcSession()).toBeNull();
  });
});

// ─── redirect_uri ────────────────────────────────────────────────────────────

describe('buildRedirectUri', () => {
  it('joins origin + base path + /auth/callback', () => {
    // jsdom default: http://localhost:3000/ with base '/'.
    expect(buildRedirectUri()).toBe('http://localhost:3000/auth/callback');
  });
});

// Silence unused-import warnings for test-only helpers used conditionally.
void tokenHandler;