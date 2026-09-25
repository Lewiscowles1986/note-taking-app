// Token endpoint: client auth (basic/post/none), PKCE verification, code
// single-use, refresh rotation + reuse detection, revocation.
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  makeOidc,
  issueCode,
  verifierAndChallenge,
  assert,
  DEV_CLIENT,
} from './helpers.mjs';
import { verifyJwt } from '../jwt.mjs';

const ISSUER = 'http://localhost:8190';
const REDIRECT = DEV_CLIENT.redirect_uris[0];

function basicHeader(id, secret) {
  return { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
}

function authPost(clientId = DEV_CLIENT.client_id, clientSecret = DEV_CLIENT.client_secret) {
  return { method: 'post', clientId, clientSecret, basicInvalid: false };
}
function authBasic(clientId = DEV_CLIENT.client_id, clientSecret = DEV_CLIENT.client_secret) {
  return { method: 'basic', clientId, clientSecret, basicInvalid: false };
}
function authNone(clientId) {
  return { method: 'none', clientId, clientSecret: undefined, basicInvalid: false };
}

test('authorization_code grant: happy path (client_secret_post) → tokens with expected claims', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.token_type, 'Bearer');
  assert.equal(res.body.expires_in, 3600);
  assert.ok(res.body.refresh_token, 'offline_access requested → refresh token present');
  const access = verifyJwt(res.body.access_token, oidc.keys.publicPem, { issuer: ISSUER, audience: DEV_CLIENT.client_id });
  assert.equal(access.payload.scope, 'openid offline_access notes.sync');
  const id = verifyJwt(res.body.id_token, oidc.keys.publicPem, { issuer: ISSUER, audience: DEV_CLIENT.client_id });
  assert.equal(id.payload.preferred_username, 'alice');
  assert.equal(id.payload.email, 'alice@example.com');
  assert.deepEqual(id.payload.amr, ['pwd']);
  assert.deepEqual(id.payload['notes.categories'], ['*']);
});

test('client_secret_basic works and malformed Basic → invalid_client with WWW-Authenticate', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const ok = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authBasic(),
  );
  assert.equal(ok.status, 200);

  const { oidc: o2 } = makeOidc();
  const c2 = issueCode(o2, { challenge });
  const bad = o2.token(
    new URLSearchParams({ grant_type: 'authorization_code', code: c2, redirect_uri: REDIRECT, code_verifier: verifier }),
    { method: 'basic', clientId: undefined, clientSecret: undefined, basicInvalid: true },
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_client');
  assert.ok(bad.headers['WWW-Authenticate']?.includes('Basic'));
});

test('wrong client secret → invalid_client (post and basic)', () => {
  const { verifier, challenge } = verifierAndChallenge();
  for (const auth of [authPost(DEV_CLIENT.client_id, 'wrong-secret'), authBasic(DEV_CLIENT.client_id, 'wrong-secret')]) {
    const { oidc } = makeOidc();
    const code = issueCode(oidc, { challenge });
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
      auth,
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_client');
  }
});

test('confidential client without any auth → invalid_client; public client with none → ok', () => {
  const { verifier, challenge } = verifierAndChallenge();
  const { oidc } = makeOidc();
  const code = issueCode(oidc, { challenge });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authNone(DEV_CLIENT.client_id),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_client');

  const { oidc: o2 } = makeOidc();
  const code2 = issueCode(o2, { clientId: 'note-haven-pkce', challenge });
  const res2 = o2.token(
    new URLSearchParams({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, code_verifier: verifier }),
    authNone('note-haven-pkce'),
  );
  assert.equal(res2.status, 200);
  assert.ok(res2.body.access_token);
});

test('public client attempting client auth → invalid_client', () => {
  const { verifier, challenge } = verifierAndChallenge();
  const { oidc } = makeOidc();
  const code = issueCode(oidc, { clientId: 'note-haven-pkce', challenge });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost('note-haven-pkce', 'some-secret'),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_client');
});

test('PKCE: wrong verifier → invalid_grant; missing verifier → invalid_request', () => {
  const { verifier, challenge } = verifierAndChallenge();
  {
    const { oidc } = makeOidc();
    const code = issueCode(oidc, { challenge });
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: `${verifier}x` }),
      authPost(),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_grant');
  }
  {
    const { oidc } = makeOidc();
    const code = issueCode(oidc, { challenge });
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }),
      authPost(),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
  }
});

test('redirect_uri mismatch → invalid_grant; unknown code → invalid_grant; unsupported grant_type', () => {
  const { verifier, challenge } = verifierAndChallenge();
  {
    const { oidc } = makeOidc();
    const code = issueCode(oidc, { challenge });
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:4173/other', code_verifier: verifier }),
      authPost(),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_grant');
  }
  {
    const { oidc } = makeOidc();
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code: 'nope', redirect_uri: REDIRECT, code_verifier: verifier }),
      authPost(),
    );
    assert.equal(res.body.error, 'invalid_grant');
  }
  {
    const { oidc } = makeOidc();
    const res = oidc.token(new URLSearchParams({ grant_type: 'password', username: 'a', password: 'b' }), authPost());
    assert.equal(res.body.error, 'unsupported_grant_type');
  }
});

test('code single-use: second exchange → invalid_grant', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const params = () => new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
  const first = oidc.token(params(), authPost());
  assert.equal(first.status, 200);
  const second = oidc.token(params(), authPost());
  assert.equal(second.status, 400);
  assert.equal(second.body.error, 'invalid_grant');
});

test('refresh rotation: old token becomes invalid, new one works', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const first = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  const rt1 = first.body.refresh_token;
  const refreshed = oidc.token(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt1 }),
    authPost(),
  );
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.refresh_token);
  assert.notEqual(refreshed.body.refresh_token, rt1);
  // Old token is rotated → using it again triggers reuse detection.
  const reuse = oidc.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt1 }), authPost());
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, 'invalid_grant');
  assert.ok(reuse.body.error_description.includes('reuse'));
});

test('refresh reuse detection revokes the whole family', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const first = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  const rt1 = first.body.refresh_token;
  const second = oidc.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt1 }), authPost());
  const rt2 = second.body.refresh_token;
  assert.ok(rt2);
  // Attacker replays rt1 → family revoked.
  const replay = oidc.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt1 }), authPost());
  assert.equal(replay.status, 400);
  // The legitimate rt2 is now dead too (family revocation).
  const legit = oidc.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt2 }), authPost());
  assert.equal(legit.status, 400);
  assert.equal(legit.body.error, 'invalid_grant');
});

test('refresh token bound to its client: other client cannot use it', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const first = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token }),
    authPost('other-client', 'irrelevant'),
  );
  assert.equal(res.status, 400);
  assert.ok(['invalid_client', 'invalid_grant'].includes(res.body.error));
});

test('revoke: refresh token revocation returns 200 and kills the token; unknown token 200', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const first = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  const rt = first.body.refresh_token;
  const revoked = oidc.revoke(new URLSearchParams({ token: rt }), authPost());
  assert.equal(revoked.status, 200);
  const after = oidc.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }), authPost());
  assert.equal(after.status, 400);
  assert.equal(after.body.error, 'invalid_grant');
  // Unknown token → still 200 (RFC 7009 §2.2).
  assert.equal(oidc.revoke(new URLSearchParams({ token: 'never-existed' }), authPost()).status, 200);
  // Missing token → 200.
  assert.equal(oidc.revoke(new URLSearchParams(''), authPost()).status, 200);
});

test('revoke: access token revocation blacklists the jti', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge, scope: 'openid notes.sync' });
  const first = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  const at = first.body.access_token;
  assert.ok(oidc.verifyAccessToken(at).ok);
  const revoked = oidc.revoke(new URLSearchParams({ token: at }), authPost());
  assert.equal(revoked.status, 200);
  const check = oidc.verifyAccessToken(at);
  assert.equal(check.ok, false);
  assert.equal(check.status, 401);
  assert.equal(check.error, 'invalid_token');
});

test('revoke requires client auth: malformed basic → 400 invalid_client', () => {
  const { oidc } = makeOidc();
  const res = oidc.revoke(new URLSearchParams({ token: 'x' }), { method: 'basic', clientId: undefined, clientSecret: undefined, basicInvalid: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_client');
});

test('expired code → invalid_grant', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const record = oidc.codes.get(code);
  record.expiresAt = Date.now() - 1000;
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_grant');
  assert.ok(res.body.error_description.includes('expired'));
});

test('client_id mismatch vs code owner → invalid_grant', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    // 'other-client' is not registered → invalid_client surfaces first; use a
    // registered-but-different client by adding one on the fly.
    authPost(),
  );
  assert.equal(res.status, 200);
  // Now the true mismatch case: register another client and try to redeem.
  oidc.store.clients.set('client-b', { client_id: 'client-b', client_secret: 'b-secret', redirect_uris: [REDIRECT], public: false });
  const codeB = issueCode(oidc, { clientId: 'client-b', challenge });
  const resB = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code: codeB, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  assert.equal(resB.status, 400);
  assert.equal(resB.body.error, 'invalid_grant');
});

test('nonce passthrough into id_token', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge, scope: 'openid' });
  const record = oidc.codes.get(code);
  record.nonce = 'n-0nce-abc';
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  const id = verifyJwt(res.body.id_token, oidc.keys.publicPem, { issuer: ISSUER, audience: DEV_CLIENT.client_id });
  assert.equal(id.payload.nonce, 'n-0nce-abc');
});

test('token without offline_access → no refresh_token issued', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge, scope: 'openid notes.sync' });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  assert.equal(res.body.refresh_token, undefined);
});

test('PKCE verifier validation (RFC 7636 §4.1): bad charset/length → 400 invalid_request, not invalid_grant', () => {
  const cases = [
    'a'.repeat(42),        // too short
    'a'.repeat(129),       // too long
    `${'a'.repeat(63)} +b`, // illegal char '+' (challenge-safe base64url char, NOT unreserved)
    `${'a'.repeat(62)} sp`, // illegal char space
  ];
  for (const verifier of cases) {
    const { oidc } = makeOidc();
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const code = issueCode(oidc, { challenge });
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
      authPost(),
    );
    assert.equal(res.status, 400, `verifier ${JSON.stringify(verifier.slice(0, 8))}… should be rejected`);
    assert.equal(res.body.error, 'invalid_request', `expected invalid_request, got ${res.body.error}`);
  }
});

test('PKCE verifier boundary lengths (43 and 128, unreserved incl. . and ~) exchange successfully', () => {
  const verifiers = ['a'.repeat(43), `${'a'.repeat(62)}._~${'b'.repeat(62)}`];
  for (const v of verifiers) {
    assert.equal(v.length >= 43 && v.length <= 128, true);
    const { oidc } = makeOidc();
    const challenge = createHash('sha256').update(v, 'ascii').digest('base64url');
    const code = issueCode(oidc, { challenge });
    const res = oidc.token(
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: v }),
      authPost(),
    );
    assert.equal(res.status, 200, `verifier of length ${v.length} should pass`);
  }
});

test('RFC 7636 appendix-B vector still exchanges (verifier contains only base64url chars)', () => {
  const { oidc } = makeOidc();
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const code = issueCode(oidc, { challenge });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  assert.equal(res.status, 200);
});

test('id_token carries at_hash = left half of SHA-256(access_token) base64url', () => {
  const { oidc } = makeOidc();
  const { verifier, challenge } = verifierAndChallenge();
  const code = issueCode(oidc, { challenge });
  const res = oidc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }),
    authPost(),
  );
  assert.equal(res.status, 200);
  const id = verifyJwt(res.body.id_token, oidc.keys.publicPem, { issuer: ISSUER, audience: DEV_CLIENT.client_id });
  const expected = createHash('sha256')
    .update(res.body.access_token, 'ascii')
    .digest()
    .subarray(0, 16)
    .toString('base64url');
  assert.equal(id.payload.at_hash, expected);
  // Unrelated claims unchanged.
  assert.equal(id.payload.preferred_username, 'alice');
  assert.deepEqual(id.payload['notes.categories'], ['*']);
});