// OIDC provider core: authorization codes, PKCE (S256), refresh-token
// rotation with family reuse detection, access/id-token issuance, revocation,
// and the login page rendering. In-memory only — codes/sessions live for
// minutes and a restart logging everyone out is acceptable (documented).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  HTML_SECURITY_HEADERS,
  HttpError,
  NO_STORE,
  redirect,
  sendHtml,
} from './http-utils.mjs';
import { signJwt, verifyJwt } from './jwt.mjs';
import { errorPageHtml, loginPageHtml, SESSION_COOKIE, verifyPassword } from './authn.mjs';

export const SCOPES_SUPPORTED = ['openid', 'profile', 'offline_access', 'notes.sync'];
export const NOTES_CLAIMS = ['notes.categories'];

export function discoveryDocument(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    revocation_endpoint: `${issuer}/revoke`,
    jwks_uri: `${issuer}/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES_SUPPORTED,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    id_token_signing_alg_values_supported: ['RS256'],
    claims_supported: ['sub', 'preferred_username', 'name', 'email', 'amr', ...NOTES_CLAIMS],
  };
}

// --- helpers ----------------------------------------------------------------

function b64urlSha256(input) {
  return createHash('sha256').update(String(input), 'ascii').digest('base64url');
}

// OIDC Core §3.1.3.6: at_hash = base64url(SHA-256(ASCII(access_token))
// truncated to its leftmost half) — the hash algorithm follows the id_token
// alg, and RS256 maps to SHA-256. The left-half truncation is what spec
// clients (openid-client, AppAuth) validate against.
export function atHashFor(accessToken) {
  const digest = createHash('sha256').update(String(accessToken), 'ascii').digest();
  return digest.subarray(0, digest.byteLength / 2).toString('base64url');
}

export function pkceChallenge(verifier) {
  return b64urlSha256(verifier);
}

// RFC 7636 §4.1: code_verifier is 43–128 chars from the unreserved set
// ALPHA / DIGIT / "-" / "." / "_" / "~". Deliberately wider than the
// challenge regex (which only matches base64url) — a verifier may contain
// '.' and '~' too.
export const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function timingSafeStringEqual(a, b) {
  const ba = Buffer.from(String(a), 'ascii');
  const bb = Buffer.from(String(b), 'ascii');
  if (ba.length !== bb.length) {
    // Compare against ourselves to burn the same time, then fail.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// --- token store ------------------------------------------------------------

export class OidcService {
  constructor({ issuer, store, keys, sessions, config }) {
    this.issuer = issuer;
    this.store = store;
    this.keys = keys; // { kid, privatePem, publicPem }
    this.sessions = sessions; // SessionManager from authn.mjs
    this.config = config;
    this.codes = new Map(); // code -> { sub, clientId, redirectUri, scope, nonce, challenge, expiresAt, used }
    this.refreshTokens = new Map(); // token -> family record
    this.revokedAccessJtis = new Set();
  }

  // --- GET /authorize -------------------------------------------------------

  // Validates the request per RFC 6749 §4.1.1 + OIDC core and renders either
  // the login page (with the OIDC request embedded as hidden fields) or an
  // error redirect to the client's redirect_uri.
  authorize(req, res, query) {
    const fail = (code, description) => this.renderAuthorizeError(req, res, query, code, description);

    const clientId = String(query.get('client_id') ?? '');
    const redirectUri = String(query.get('redirect_uri') ?? '');
    const responseType = String(query.get('response_type') ?? '');
    const scope = String(query.get('scope') ?? '');
    const state = query.get('state');
    const nonce = query.get('nonce');
    const codeChallenge = String(query.get('code_challenge') ?? '');
    const codeChallengeMethod = String(query.get('code_challenge_method') ?? '');

    const client = clientId ? this.store.getClient(clientId) : null;
    if (!client) {
      return this.renderErrorPage(req, res, 400, 'Unknown application', `The client_id ${JSON.stringify(clientId || '(missing)')} is not registered.`);
    }
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return this.renderErrorPage(req, res, 400, 'Invalid redirect', 'redirect_uri is missing or does not exactly match a registered redirect URI.');
    }
    // From here on errors go back to the client via redirect (per RFC 6749
    // §4.1.2.1) since the redirect_uri itself has been validated.
    if (responseType !== 'code') {
      return fail('unsupported_response_type', 'response_type must be "code"');
    }
    const requested = scope ? scope.split(' ').filter(Boolean) : [];
    if (requested.length === 0 || requested.some((s) => !SCOPES_SUPPORTED.includes(s))) {
      return fail('invalid_scope', `scope must be a space-separated subset of: ${SCOPES_SUPPORTED.join(' ')}`);
    }
    if (!codeChallenge) {
      return fail('invalid_request', 'PKCE is required: code_challenge is missing');
    }
    if (codeChallengeMethod !== 'S256') {
      // 'plain' and anything else are rejected — S256 only.
      return fail('invalid_request', 'code_challenge_method must be S256 (plain is not accepted)');
    }
    if (!/^[A-Za-z0-9\-_]{43,128}$/.test(codeChallenge)) {
      return fail('invalid_request', 'code_challenge must be base64url of a SHA-256 digest (43–128 chars)');
    }

    // Already logged in? Skip straight to code issuance.
    const cookies = req.parsedCookies ?? {};
    const session = this.sessions.verify(cookies[SESSION_COOKIE]);
    if (session) {
      return this.issueCodeAndRedirect(req, res, {
        client, redirectUri, scope: requested, state, nonce, codeChallenge, sub: session.sub,
      });
    }

    const html = loginPageHtml({
      action: '/authorize/submit',
      error: '',
      username: '',
    });
    // The pending OIDC request travels through hidden form fields (rather
    // than only the session) so the flow survives cookie-less state and is
    // trivially testable.
    const pending = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      scope: scope,
      state: state ?? '',
      nonce: nonce ?? '',
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    };
    return sendHtml(res, 200, loginFormWithPending(html, pending), {
      ...NO_STORE,
      ...HTML_SECURITY_HEADERS,
      ...corsHeadersIfAny(req),
    });
  }

  renderAuthorizeError(req, res, query, code, description) {
    const redirectUri = String(query.get('redirect_uri') ?? '');
    const clientId = String(query.get('client_id') ?? '');
    const client = this.store.getClient(clientId);
    if (client && redirectUri && client.redirect_uris.includes(redirectUri)) {
      const url = new URL(redirectUri);
      url.searchParams.set('error', code);
      url.searchParams.set('error_description', description);
      const state = query.get('state');
      if (state !== null) url.searchParams.set('state', state);
      return redirect(res, url.toString(), { ...NO_STORE, ...corsHeadersIfAny(req) });
    }
    // redirect_uri not (yet) validatable → human-readable 400 page.
    return this.renderErrorPage(req, res, 400, 'Authorization error', `${code}: ${description}`);
  }

  renderErrorPage(req, res, status, title, detail) {
    return sendHtml(res, status, errorPageHtml(title, detail), {
      ...NO_STORE,
      ...HTML_SECURITY_HEADERS,
      ...corsHeadersIfAny(req),
    });
  }

  // --- POST /authorize/submit ----------------------------------------------

  // Consumes the hidden pending-OIDC fields + username/password. On success:
  // create session, issue code, 302 back to the client. On bad credentials:
  // re-render the login form (200, so browsers re-render cleanly) with an
  // inline error. Missing/invalid pending fields → 400 error page.
  submitLogin(req, res, form) {
    const pending = readPending(form);
    if (!pending) {
      return this.renderErrorPage(req, res, 400, 'Invalid login request', 'The login form is missing its authorisation context. Start again from the application.');
    }
    const client = this.store.getClient(pending.client_id);
    if (!client || !client.redirect_uris.includes(pending.redirect_uri)) {
      return this.renderErrorPage(req, res, 400, 'Invalid login request', 'The login form references an unknown client or redirect URI.');
    }

    const user = this.authenticateUser(form.get('username'), form.get('password'));
    if (!user) {
      const html = loginPageHtml({
        action: '/authorize/submit',
        error: 'Wrong username or password.',
        username: String(form.get('username') ?? ''),
      });
      return sendHtml(res, 200, loginFormWithPending(html, pending), {
        ...NO_STORE,
        ...HTML_SECURITY_HEADERS,
        ...corsHeadersIfAny(req),
      });
    }

    const session = this.sessions.create(user);
    res.setHeader('Set-Cookie', session.cookie);
    return this.issueCodeAndRedirect(req, res, {
      client,
      redirectUri: pending.redirect_uri,
      scope: pending.scope.split(' ').filter(Boolean),
      state: pending.state || null,
      nonce: pending.nonce || null,
      codeChallenge: pending.code_challenge,
      sub: user.sub,
    });
  }

  authenticateUser(username, password) {
    const user = this.store.findUserByUsername(String(username ?? ''));
    if (!user) {
      scryptSync(String(password ?? ''), 'decoy-salt', 64); // constant-ish time
      return null;
    }
    if (!verifyPassword(password, user.salt, user.hash)) return null;
    return user;
  }

  issueCodeAndRedirect(req, res, { client, redirectUri, scope, state, nonce, codeChallenge, sub }) {
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      sub,
      clientId: client.client_id,
      redirectUri,
      scope: scope.join(' '),
      nonce: nonce ?? null,
      challenge: codeChallenge,
      expiresAt: Date.now() + this.config.authorizationCodeTtlSeconds * 1000,
      used: false,
    });
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state !== null && state !== undefined) url.searchParams.set('state', String(state));
    return redirect(res, url.toString(), { ...NO_STORE, ...corsHeadersIfAny(req) });
  }

  // --- POST /token ----------------------------------------------------------

  // Returns { status, headers, body } — pure enough to unit-test without a
  // socket; the router writes it.
  token(grantParams, clientAuth) {
    const grantType = String(grantParams.get('grant_type') ?? '');
    if (grantType === 'authorization_code') {
      return this.tokenAuthorizationCode(grantParams, clientAuth);
    }
    if (grantType === 'refresh_token') {
      return this.tokenRefresh(grantParams, clientAuth);
    }
    return tokenError(400, 'unsupported_grant_type', `grant_type must be authorization_code or refresh_token (got ${JSON.stringify(grantType)})`);
  }

  // clientAuth: { method: 'none'|'basic'|'post'|'both', clientId, clientSecret, basicInvalid }
  tokenAuthorizationCode(params, clientAuth) {
    const code = String(params.get('code') ?? '');
    const redirectUri = String(params.get('redirect_uri') ?? '');
    const verifier = String(params.get('code_verifier') ?? '');
    if (!code) return tokenError(400, 'invalid_request', 'code is required');
    if (!redirectUri) return tokenError(400, 'invalid_request', 'redirect_uri is required');

    const record = this.codes.get(code);
    if (!record) return tokenError(400, 'invalid_grant', 'unknown authorization code');

    const auth = this.requireClient(clientAuth, record.clientId);
    if (auth.error) return auth.error;
    const client = auth.client;

    if (record.expiresAt <= Date.now()) {
      this.codes.delete(code);
      return tokenError(400, 'invalid_grant', 'authorization code expired');
    }
    // Single-use per RFC 6749 §4.1.2: a replayed code rejects with
    // invalid_grant. The first exchange's tokens stay valid for their short
    // lifetime; the tradeoff is documented in server/README.md.
    if (record.used) {
      // RFC 6749 §4.1.2: a replayed code is rejected with invalid_grant. The
      // first exchange's tokens stay valid for their (short) lifetime; the
      // tradeoff is documented in server/README.md.
      this.codes.delete(code);
      return tokenError(400, 'invalid_grant', 'authorization code has already been used');
    }
    if (record.redirectUri !== redirectUri) {
      return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (record.clientId !== client.client_id) {
      return tokenError(400, 'invalid_grant', 'code was issued to a different client');
    }
    if (!verifier) return tokenError(400, 'invalid_request', 'code_verifier is required (PKCE)');
    if (!CODE_VERIFIER_RE.test(verifier)) {
      return tokenError(400, 'invalid_request', 'code_verifier must be 43–128 characters from the RFC 7636 unreserved set (A-Z a-z 0-9 - . _ ~)');
    }
    if (!timingSafeStringEqual(pkceChallenge(verifier), record.challenge)) {
      return tokenError(400, 'invalid_grant', 'PKCE verification failed');
    }

    record.used = true;
    this.codes.set(code, record);
    return this.issueTokens({ sub: record.sub, clientId: record.clientId, scope: record.scope, nonce: record.nonce });
  }

  tokenRefresh(params, clientAuth) {
    const token = String(params.get('refresh_token') ?? '');
    if (!token) return tokenError(400, 'invalid_request', 'refresh_token is required');
    const record = this.refreshTokens.get(token);
    if (!record) return tokenError(400, 'invalid_grant', 'unknown refresh token');

    const auth = this.requireClient(clientAuth, record.clientId);
    if (auth.error) return auth.error;
    const client = auth.client;

    if (record.rotated) {
      // Reuse of a rotated refresh token → revoke the whole family.
      this.revokeFamily(record.familyId);
      return tokenError(400, 'invalid_grant', 'refresh token reuse detected; token family revoked');
    }
    if (record.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.refreshTokens.delete(token);
      return tokenError(400, 'invalid_grant', 'refresh token expired');
    }
    if (record.clientId !== client.client_id) {
      return tokenError(400, 'invalid_grant', 'refresh token was issued to a different client');
    }

    // Rotate: mark old token rotated, issue a new one in the same family.
    record.rotated = true;
    this.refreshTokens.set(token, record);
    return this.issueTokens({
      sub: record.sub,
      clientId: record.clientId,
      scope: record.scope,
      nonce: null,
      familyId: record.familyId,
    });
  }

  // Returns { client } on success or { error: <tokenError response> } on
  // failure — callers check `.error` and return it directly.
  requireClient(clientAuth, expectedClientId) {
    if (clientAuth.basicInvalid) {
      return { error: tokenError(
        400,
        'invalid_client',
        'client_secret_basic credentials are malformed',
        { 'WWW-Authenticate': 'Basic realm="note-haven-token", error="invalid_client"' },
      ) };
    }
    const clientId = clientAuth.clientId;
    if (!clientId) return { error: tokenError(400, 'invalid_request', 'client_id is required') };
    const client = this.store.getClient(clientId);
    if (!client) return { error: tokenError(400, 'invalid_client', 'unknown client') };
    if (clientAuth.method === 'basic' || clientAuth.method === 'post') {
      if (client.public) {
        return { error: tokenError(400, 'invalid_client', 'this client is public and must not authenticate with a secret') };
      }
      const expected = client.client_secret;
      const given = clientAuth.clientSecret ?? '';
      if (typeof expected !== 'string' || !timingSafeStringEqual(given, expected)) {
        return { error: tokenError(
          400,
          'invalid_client',
          'client authentication failed',
          { 'WWW-Authenticate': 'Basic realm="note-haven-token", error="invalid_client"' },
        ) };
      }
    }
    // method === 'none': allowed for public clients; confidential clients MUST
    // authenticate, so a bare client_id from them is an error.
    if (clientAuth.method === 'none' && !client.public) {
      return { error: tokenError(400, 'invalid_client', 'this client must authenticate with its secret (client_secret_basic or client_secret_post)') };
    }
    if (expectedClientId && clientId !== expectedClientId) {
      return { error: tokenError(400, 'invalid_grant', 'client_id does not match the grant') };
    }
    return { client };
  }

  issueTokens({ sub, clientId, scope, nonce, familyId, code }) {
    const now = Math.floor(Date.now() / 1000);
    const user = this.store.findUserBySub(sub);
    const expiresIn = this.config.accessTokenTtlSeconds;
    const jti = randomBytes(16).toString('hex');

    const accessToken = signJwt(
      {
        iss: this.issuer,
        sub,
        aud: clientId,
        iat: now,
        exp: now + expiresIn,
        jti,
        scope,
      },
      this.keys.privatePem,
      { kid: this.keys.kid },
    );

    const idToken = signJwt(
      {
        iss: this.issuer,
        sub,
        aud: clientId,
        iat: now,
        exp: now + expiresIn,
        ...(nonce ? { nonce } : {}),
        preferred_username: user?.username ?? sub,
        name: user?.name ?? null,
        email: user?.email ?? null,
        amr: ['pwd'],
        // OIDC Core §3.1.3.6: binds the id_token to the access token (code
        // flow). Leftmost half of SHA-256 of the ASCII access token, base64url.
        at_hash: atHashFor(accessToken),
        // Claims bound to the notes.sync scope so clients can discover what
        // they may sync without an extra round trip.
        ...(scope.split(' ').includes('notes.sync') ? { 'notes.categories': ['*'] } : {}),
      },
      this.keys.privatePem,
      { kid: this.keys.kid },
    );

    // Refresh token (only when offline_access was granted).
    let refreshToken;
    if (scope.split(' ').includes('offline_access')) {
      const family = familyId ?? randomBytes(12).toString('hex');
      refreshToken = randomBytes(32).toString('base64url');
      this.refreshTokens.set(refreshToken, {
        sub,
        clientId,
        scope,
        familyId: family,
        rotated: false,
        issuedAt: now,
        expiresAt: now + this.config.refreshTokenTtlSeconds,
      });
    }

    return {
      status: 200,
      headers: { ...NO_STORE },
      body: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        id_token: idToken,
        scope,
      },
    };
  }

  // --- Bearer access-token verification (used by /userinfo and /api/*) ------

  verifyAccessToken(bearerToken, { scope } = {}) {
    let payload;
    try {
      ({ payload } = verifyJwt(bearerToken, this.keys.publicPem, { issuer: this.issuer }));
    } catch {
      return { ok: false, status: 401, error: 'invalid_token', error_description: 'access token is invalid or expired' };
    }
    if (this.revokedAccessJtis.has(payload.jti)) {
      return { ok: false, status: 401, error: 'invalid_token', error_description: 'access token has been revoked' };
    }
    if (scope && !String(payload.scope ?? '').split(' ').includes(scope)) {
      return { ok: false, status: 403, error: 'insufficient_scope', error_description: `token lacks required scope ${scope}` };
    }
    return { ok: true, payload };
  }

  // --- GET /userinfo ---------------------------------------------------------

  userinfo(bearerPayload) {
    const user = this.store.findUserBySub(bearerPayload.sub);
    return {
      sub: bearerPayload.sub,
      preferred_username: user?.username ?? bearerPayload.sub,
      name: user?.name ?? null,
      email: user?.email ?? null,
      scope: bearerPayload.scope ?? '',
      ...(String(bearerPayload.scope ?? '').split(' ').includes('notes.sync') ? { 'notes.categories': ['*'] } : {}),
    };
  }

  // --- POST /revoke (RFC 7009) ------------------------------------------------

  // Always 200 per RFC 7009 §2.2 — even for unknown tokens. Revokes either an
  // access token (by jti) or a refresh token (plus its family on reuse? no:
  // revocation revokes just that refresh token per RFC 7009; family revocation
  // happens on reuse detection).
  revoke(form, clientAuth) {
    const token = String(form.get('token') ?? '');
    const auth = this.requireClient(clientAuth, null);
    if (auth.error) return auth.error; // RFC 7009: auth failures ARE errors
    const client = auth.client;
    if (!token) {
      return { status: 200, headers: { ...NO_STORE }, body: '' };
    }

    // Refresh token?
    const refreshRecord = this.refreshTokens.get(token);
    if (refreshRecord) {
      if (client.client_id !== refreshRecord.clientId) {
        // Wrong client: respond 200 without revoking (do not leak validity).
        return { status: 200, headers: { ...NO_STORE }, body: '' };
      }
      this.refreshTokens.delete(token);
      return { status: 200, headers: { ...NO_STORE }, body: '' };
    }

    // Access token? Verify signature, then blacklist its jti.
    try {
      const { payload } = verifyJwt(token, this.keys.publicPem, { issuer: this.issuer });
      if (payload.aud === client.client_id) {
        this.revokedAccessJtis.add(payload.jti);
      }
    } catch {
      /* unknown/invalid token → 200 per RFC */
    }
    return { status: 200, headers: { ...NO_STORE }, body: '' };
  }

  // Internal: revoke every member of a refresh family.
  revokeFamily(familyId) {
    for (const [tok, rec] of [...this.refreshTokens]) {
      if (rec.familyId === familyId) this.refreshTokens.delete(tok);
    }
  }
}

function corsHeadersIfAny(req) {
  const origin = req.headers?.origin;
  return origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'false' } : {};
}

// Embed the pending OIDC request as hidden inputs so POST /authorize/submit
// can rebuild the redirect without server-side flow state.
function loginFormWithPending(baseHtml, pending) {
  const hidden = Object.entries(pending)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${String(value).replaceAll('"', '&quot;')}">`)
    .join('\n    ');
  return baseHtml.replace('</form>', `    ${hidden}\n  </form>`);
}

function readPending(form) {
  const clientId = form.get('client_id');
  const redirectUri = form.get('redirect_uri');
  const codeChallenge = form.get('code_challenge');
  if (!clientId || !redirectUri || !codeChallenge) return null;
  return {
    client_id: String(clientId),
    redirect_uri: String(redirectUri),
    response_type: String(form.get('response_type') ?? 'code'),
    scope: String(form.get('scope') ?? ''),
    state: String(form.get('state') ?? ''),
    nonce: String(form.get('nonce') ?? ''),
    code_challenge: String(codeChallenge),
    code_challenge_method: String(form.get('code_challenge_method') ?? 'S256'),
  };
}

function tokenError(status, error, description, headers = {}) {
  return {
    status,
    headers: { ...NO_STORE, ...headers },
    body: { error, error_description: description },
  };
}

export { HttpError };