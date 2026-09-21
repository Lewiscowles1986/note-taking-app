// Notes API: user isolation, tombstone lifecycle, manifest shape, CORS
// preflight, body-size cap, scope enforcement, token-endpoint content-type.
// These tests drive the real router over a real (localhost) HTTP server —
// loopback only, no external network.
import test, { after, before, describe } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { buildConfig } from '../config.mjs';
import { Store } from '../store.mjs';
import { SessionManager, hashPassword } from '../authn.mjs';
import { OidcService } from '../oidc.mjs';
import { loadOrCreateKeys } from '../keys.mjs';
import { createRouter } from '../routes.mjs';
import { DEV_USERS, DEV_CLIENT, assert, memoryIo } from './helpers.mjs';

const ISSUER = 'http://localhost:8191';

let server;
let baseUrl;
let aliceToken;
let bobToken;
let keys;
let oidc;
let store;

function issueFor(oidcSvc, username, scope = 'openid offline_access notes.sync') {
  const user = oidcSvc.store.findUserByUsername(username);
  const verifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = `code-${Math.random().toString(36).slice(2)}`;
  oidcSvc.codes.set(code, {
    sub: user.sub,
    clientId: DEV_CLIENT.client_id,
    redirectUri: DEV_CLIENT.redirect_uris[0],
    scope,
    nonce: null,
    challenge,
    expiresAt: Date.now() + 600_000,
    used: false,
  });
  const res = oidcSvc.token(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: DEV_CLIENT.redirect_uris[0], code_verifier: verifier }),
    { method: 'post', clientId: DEV_CLIENT.client_id, clientSecret: DEV_CLIENT.client_secret, basicInvalid: false },
  );
  assert.equal(res.status, 200);
  return res.body;
}

function request(method, path, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (raw ? body : JSON.stringify(body));
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(data !== null && !raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(data !== null && raw ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        json: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })(),
      }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

// Send a raw request over a socket (for malformed targets the http module
// would refuse to build itself) and resolve with the full response text.
function rawRequest(raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(new URL(baseUrl).port, '127.0.0.1');
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.end(raw));
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

before(async () => {
  const { writeAsync, writeSync, files } = memoryIo();
  keys = await loadOrCreateKeys('/tmp/unused', { io: { write: async (p, d) => files.set(p, d) } });
  store = new Store('/unused', { io: { writeAsync, writeSync } });
  await store.load();
  for (const seed of DEV_USERS) {
    const { salt, hash } = hashPassword(seed.password);
    store.upsertUser({ sub: `sub-${seed.username}`, username: seed.username, email: seed.email, name: seed.name, salt, hash, created_at: '2026-01-01' });
  }
  const sessions = new SessionManager({ secret: 'test-secret' });
  const config = buildConfig({ args: { issuer: ISSUER } });
  oidc = new OidcService({ issuer: ISSUER, store, keys, sessions, config });
  const router = createRouter({ config, store, oidc, keys, sessions });
  server = http.createServer(router);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  aliceToken = issueFor(oidc, 'alice').access_token;
  bobToken = issueFor(oidc, 'bob').access_token;
});

after(() => {
  server?.close();
});

describe('discovery', () => {
  test('discovery document has the required metadata', async () => {
    const res = await request('GET', '/.well-known/openid-configuration');
    assert.equal(res.status, 200);
    const doc = res.json;
    assert.equal(doc.issuer, ISSUER);
    assert.equal(doc.authorization_endpoint, `${ISSUER}/authorize`);
    assert.equal(doc.token_endpoint, `${ISSUER}/token`);
    assert.equal(doc.jwks_uri, `${ISSUER}/jwks.json`);
    assert.deepEqual(doc.response_types_supported, ['code']);
    assert.deepEqual(doc.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(doc.scopes_supported, ['openid', 'profile', 'offline_access', 'notes.sync']);
    assert.ok(doc.token_endpoint_auth_methods_supported.includes('client_secret_post'));
    assert.ok(doc.token_endpoint_auth_methods_supported.includes('client_secret_basic'));
    assert.ok(doc.token_endpoint_auth_methods_supported.includes('none'));
    assert.deepEqual(doc.id_token_signing_alg_values_supported, ['RS256']);
    for (const claim of ['sub', 'preferred_username', 'name', 'email']) {
      assert.ok(doc.claims_supported.includes(claim), `claims_supported includes ${claim}`);
    }
  });

  test('jwks.json exposes an RSA/RS256 key matching kid', async () => {
    const res = await request('GET', '/jwks.json');
    assert.equal(res.status, 200);
    const jwk = res.json.keys[0];
    assert.equal(jwk.kty, 'RSA');
    assert.equal(jwk.use, 'sig');
    assert.equal(jwk.alg, 'RS256');
    assert.equal(jwk.kid, keys.kid);
    assert.ok(jwk.n.length > 100);
    assert.equal(jwk.e, 'AQAB');
  });
});

describe('routing hardening', () => {
  test('malformed percent-encoding target → 400 invalid_request, process survives', async () => {
    const res = await rawRequest('GET /%zz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(res, /^HTTP\/1\.1 400 /);
    assert.match(res, /"error"\s*:\s*"invalid_request"/);
    assert.match(res, /malformed request target/);
    // The server is still alive and serving (no uncaughtException death).
    const health = await request('GET', '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
  });

  test('HEAD mirrors GET everywhere: /api/notes, discovery, healthz, userinfo; empty body', async () => {
    for (const [path, headers] of [
      ['/api/notes', { authorization: `Bearer ${aliceToken}` }],
      ['/.well-known/openid-configuration', {}],
      ['/healthz', {}],
      ['/userinfo', { authorization: `Bearer ${aliceToken}` }],
      ['/jwks.json', {}],
    ]) {
      const head = await request('HEAD', path, { headers });
      const get = await request('GET', path, { headers });
      assert.equal(head.status, get.status, `HEAD vs GET status for ${path}`);
      assert.equal(head.body, '', `HEAD body must be empty for ${path}`);
    }
  });

  test('HEAD / still 200', async () => {
    const res = await request('HEAD', '/');
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
  });

  test('405 on /api/notes lists HEAD in Allow', async () => {
    const res = await request('POST', '/api/notes', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 405);
    assert.match(res.headers.allow ?? '', /HEAD/);
  });

  test('GET /token → 405 with Allow: POST (not 404)', async () => {
    const res = await request('GET', '/token');
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'POST');
    assert.equal(res.json.error, 'method_not_allowed');
  });
});

describe('notes API auth', () => {
  test('401 without token (WWW-Authenticate: Bearer)', async () => {
    const res = await request('GET', '/api/notes');
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] ?? '', /Bearer/);
  });

  test('401 with garbage token', async () => {
    const res = await request('GET', '/api/notes', { headers: { authorization: 'Bearer not.a.jwt' } });
    assert.equal(res.status, 401);
  });

  test('403 when token lacks notes.sync scope', async () => {
    const tokens = issueFor(oidc, 'alice', 'openid');
    const res = await request('GET', '/api/notes', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'insufficient_scope');
  });
});

describe('notes CRUD + isolation', () => {
  test('PUT → manifest → GET roundtrip', async () => {
    const note = { uid: 'uid-a', title: 'Trip', content: 'pack bags', category: 'Travel', updatedAt: '2026-09-20T01:00:00.000Z', tags: ['x'] };
    const put = await request('PUT', '/api/notes/uid-a', { body: note, headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(put.status, 200);
    const manifest = await request('GET', '/api/notes', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.json, { notes: [{ uid: 'uid-a', updatedAt: '2026-09-20T01:00:00.000Z' }] });
    const got = await request('GET', '/api/notes/uid-a', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(got.status, 200);
    assert.equal(got.json.title, 'Trip');
    assert.equal(got.json.uid, 'uid-a');
  });

  test('user isolation: bob cannot see alice notes', async () => {
    const manifest = await request('GET', '/api/notes', { headers: { authorization: `Bearer ${bobToken}` } });
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.json.notes, []);
    const got = await request('GET', '/api/notes/uid-a', { headers: { authorization: `Bearer ${bobToken}` } });
    assert.equal(got.status, 404);
    // bob PUT to same uid does not disturb alice's copy
    await request('PUT', '/api/notes/uid-a', { body: { uid: 'uid-a', title: 'bob note', updatedAt: '2026-09-21T00:00:00.000Z' }, headers: { authorization: `Bearer ${bobToken}` } });
    const aliceNote = await request('GET', '/api/notes/uid-a', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(aliceNote.json.title, 'Trip');
  });

  test('tombstone lifecycle: PUT → DELETE → manifest deleted:true → GET 404 → PUT resurrects', async () => {
    const headers = { authorization: `Bearer ${bobToken}` };
    await request('PUT', '/api/notes/uid-b', { body: { uid: 'uid-b', title: 'b1', updatedAt: '2026-09-20T00:00:00.000Z' }, headers });
    const del = await request('DELETE', '/api/notes/uid-b', { headers });
    assert.ok([200, 204].includes(del.status));
    const manifest = await request('GET', '/api/notes', { headers });
    const entry = manifest.json.notes.find((n) => n.uid === 'uid-b');
    assert.ok(entry, 'tombstone stays in manifest');
    assert.equal(entry.deleted, true);
    assert.ok(entry.updatedAt, 'tombstone carries updatedAt');
    const got = await request('GET', '/api/notes/uid-b', { headers });
    assert.equal(got.status, 404);
    assert.equal(got.json.error, 'not_found');
    // Resurrect.
    const put = await request('PUT', '/api/notes/uid-b', { body: { uid: 'uid-b', title: 'b2', updatedAt: '2026-09-22T00:00:00.000Z' }, headers });
    assert.equal(put.status, 200);
    const manifest2 = await request('GET', '/api/notes', { headers });
    const entry2 = manifest2.json.notes.find((n) => n.uid === 'uid-b');
    assert.equal(entry2.deleted, undefined);
    assert.equal(entry2.updatedAt, '2026-09-22T00:00:00.000Z');
    const got2 = await request('GET', '/api/notes/uid-b', { headers });
    assert.equal(got2.status, 200);
    assert.equal(got2.json.title, 'b2');
  });

  test('PUT without updatedAt falls back to server clock', async () => {
    const res = await request('PUT', '/api/notes/uid-c', { body: { uid: 'uid-c', title: 'no clock' }, headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 200);
    const manifest = await request('GET', '/api/notes', { headers: { authorization: `Bearer ${aliceToken}` } });
    const entry = manifest.json.notes.find((n) => n.uid === 'uid-c');
    assert.ok(!Number.isNaN(Date.parse(entry.updatedAt)));
  });

  test('PUT with body uid ≠ path uid → 400', async () => {
    const res = await request('PUT', '/api/notes/real-uid', { body: { uid: 'MISMATCH', title: 'x' }, headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_request');
    assert.match(res.json.error_description, /uid does not match path uid/);
  });

  test('PUT with matching body uid → 200 and payload mirrors path', async () => {
    const res = await request('PUT', '/api/notes/uid-match', { body: { uid: 'uid-match', title: 'ok' }, headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 200);
    const got = await request('GET', '/api/notes/uid-match', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(got.json.uid, 'uid-match');
  });

  test('PUT with absent body uid → 200 (server fills it in)', async () => {
    const res = await request('PUT', '/api/notes/uid-absent', { body: { title: 'no uid field' }, headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 200);
    const got = await request('GET', '/api/notes/uid-absent', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(got.json.uid, 'uid-absent');
  });

  test('PUT with invalid JSON → 400', async () => {
    const res = await request('PUT', '/api/notes/uid-x', { body: '{not json', raw: true, headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_request');
  });

  test('DELETE of unknown uid is idempotent (200) and creates tombstone', async () => {
    const res = await request('DELETE', '/api/notes/never-existed', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.ok([200, 204].includes(res.status));
    const manifest = await request('GET', '/api/notes', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.ok(manifest.json.notes.some((n) => n.uid === 'never-existed' && n.deleted === true));
  });

  test('405 with Allow header on /api/notes', async () => {
    const res = await request('POST', '/api/notes', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 405);
    assert.match(res.headers.allow ?? '', /GET/);
  });
});

describe('CORS', () => {
  test('preflight → 204 with ACAO/ACAM/ACAH/MAX-AGE and no Content-Type', async () => {
    const res = await request('OPTIONS', '/api/notes', { headers: { origin: 'http://localhost:4173', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:4173');
    assert.match(res.headers['access-control-allow-methods'] ?? '', /PUT/);
    assert.match(res.headers['access-control-allow-headers'] ?? '', /Authorization/);
    assert.ok(res.headers['access-control-max-age']);
    assert.equal(res.headers['content-type'], undefined);
  });

  test('actual responses echo origin', async () => {
    const res = await request('GET', '/api/notes', { headers: { origin: 'http://localhost:4173', authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:4173');
    assert.equal(res.headers['access-control-allow-credentials'], 'false');
  });
});

describe('body size cap', () => {
  test('body > 1 MiB → 413', async () => {
    const big = JSON.stringify({ uid: 'uid-big', title: 'x'.repeat(1100 * 1024) });
    const res = await request('PUT', '/api/notes/uid-big', { body: big, raw: true, headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' } });
    assert.equal(res.status, 413);
  });
});

describe('token endpoint content-type enforcement', () => {
  test('JSON body to /token → 415', async () => {
    const res = await request('POST', '/token', { body: { grant_type: 'authorization_code' }, headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 415);
    assert.equal(res.json.error, 'invalid_request');
  });

  test('form-encoded body to /token works (invalid grant shape still maps to RFC error)', async () => {
    const form = 'grant_type=authorization_code&code=missing&redirect_uri=x&code_verifier=y&client_id=note-haven-dev&client_secret=dev-secret-not-for-prod';
    const res = await request('POST', '/token', { body: form, raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_grant');
  });
});

describe('userinfo', () => {
  test('Bearer → claims for the token subject', async () => {
    const res = await request('GET', '/userinfo', { headers: { authorization: `Bearer ${aliceToken}` } });
    assert.equal(res.status, 200);
    assert.equal(res.json.preferred_username, 'alice');
    assert.equal(res.json.email, 'alice@example.com');
    assert.match(res.json.scope, /notes\.sync/);
  });
});

describe('authorize endpoint (HTML flow)', () => {
  test('GET /authorize with valid params → 200 login page (cookie-addressed pending, NO hidden fields)', async () => {
    const challenge = Buffer.from('a'.repeat(32)).toString('base64url');
    const res = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid%20notes.sync&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<form method="post" action="\/authorize\/submit">/);
    // Chromium blocks the form POST under form-action 'self' whenever the form
    // carries ANY hidden input (A/B-verified) — the flow context must travel
    // in the nh_pending cookie instead.
    assert.doesNotMatch(res.body, /<input type="hidden"/);
    // The cookie must be HttpOnly + SameSite=Lax and scoped to /authorize.
    const setCookie = String(res.headers['set-cookie']);
    assert.match(setCookie, /nh_pending=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/authorize/);
  });

  test('pending cookie is single-use: replaying the submitted form → 400', async () => {
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid%20notes.sync&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`);
    const cookie = String(start.headers['set-cookie'] ?? '').split(';')[0];
    const form = () => 'username=alice&password=correct-horse-battery-staples';
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    const first = await request('POST', '/authorize/submit', { body: form(), raw: true, headers });
    assert.equal(first.status, 200);
    assert.match(first.body, /http-equiv="refresh"/);
    assert.match(first.body, /code=/);
    const replay = await request('POST', '/authorize/submit', { body: form(), raw: true, headers });
    assert.equal(replay.status, 400);
    assert.match(replay.body, /expired|authorisation context/i);
  });

  test('GET /authorize with plain method → 302 error redirect', async () => {
    const challenge = Buffer.from('a'.repeat(32)).toString('base64url');
    const res = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid&code_challenge=${challenge}&code_challenge_method=plain&state=s1`);
    assert.equal(res.status, 302);
    assert.match(res.headers.location ?? '', /error=invalid_request/);
    assert.match(res.headers.location ?? '', /state=s1/);
  });

  test('unknown client_id → 400 page', async () => {
    const res = await request('GET', `/authorize?client_id=nope&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`);
    assert.equal(res.status, 400);
  });

  test('redirect_uri mismatch → 400 page (never a redirect)', async () => {
    const res = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent('http://evil.example/cb')}&response_type=code&scope=openid&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`);
    assert.equal(res.status, 400);
    assert.match(res.body, /redirect_uri/);
  });

  test('full login submit → 200 handoff page with code + state (NOT a 302: Chromium applies form-action to the POST response, blocking cross-origin redirects); bad password → re-rendered form with a FRESH pending cookie', async () => {
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid%20offline_access%20notes.sync&state=st-99&nonce=n-1&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.equal(start.status, 200);
    // The pending context rides in the nh_pending cookie (no hidden fields —
    // Chromium form-action CSP blocks the POST when any hidden input exists).
    const cookieOf = (res) => String(res.headers['set-cookie'] ?? '').split(';').find((c) => c.startsWith('nh_pending=')) ?? '';
    const submit = (cookie, password) => request('POST', '/authorize/submit', { body: `username=alice&password=${encodeURIComponent(password)}`, raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) } });
    // wrong password → re-rendered form + a FRESH pending cookie; the retried
    // POST must use the NEWLY issued cookie (old id is consumed).
    const bad = await submit(cookieOf(start), 'wrong');
    assert.equal(bad.status, 200);
    assert.match(bad.body, /Wrong username or password/);
    // right password (fresh cookie from the re-rendered response) → 200
    // handoff page: the meta refresh carries code+state to the client's
    // redirect_uri (a 302 here would be blocked by form-action 'self').
    const good = await submit(cookieOf(bad), 'correct-horse-battery-staples');
    assert.equal(good.status, 200);
    assert.match(good.body, /http-equiv="refresh"/);
    const match = good.body.match(/content="0;url=([^"]+)"/);
    assert.ok(match, 'handoff page must carry the meta-refresh target');
    const location = new URL(match[1].replace(/&amp;/g, '&'));
    assert.equal(location.origin + location.pathname, DEV_CLIENT.redirect_uris[0]);
    assert.equal(location.searchParams.get('state'), 'st-99');
    assert.ok(location.searchParams.get('code'));
    // exchange the browser-flow code
    const tokenRes = await request('POST', '/token', { body: `grant_type=authorization_code&code=${location.searchParams.get('code')}&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&code_verifier=${verifier}&client_id=note-haven-dev&client_secret=dev-secret-not-for-prod`, raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.json.token_type, 'Bearer');
    const idClaims = JSON.parse(Buffer.from(tokenRes.json.id_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(idClaims.preferred_username, 'alice');
    assert.equal(idClaims.nonce, 'n-1');
  });

  test('login accepts EMAIL as the identifier (alice@example.com) — full flow', async () => {
    const verifier = 'e'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid%20offline_access%20notes.sync&state=st-em&nonce=n-em&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.equal(start.status, 200);
    const cookieOf = (res) => String(res.headers['set-cookie'] ?? '').split(';').find((c) => c.startsWith('nh_pending=')) ?? '';
    const submit = (cookie, identifier, password) => request('POST', '/authorize/submit', { body: `username=${encodeURIComponent(identifier)}&password=${encodeURIComponent(password)}`, raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) } });
    const viaEmail = await submit(cookieOf(start), 'alice@example.com', 'correct-horse-battery-staples');
    assert.equal(viaEmail.status, 200);
    assert.match(viaEmail.body, /http-equiv="refresh"/);
    const match = viaEmail.body.match(/content="0;url=([^"]+)"/);
    assert.ok(match, 'email login must reach the handoff page');
    const location = new URL(match[1].replace(/&amp;/g, '&'));
    assert.equal(location.searchParams.get('state'), 'st-em');
    assert.ok(location.searchParams.get('code'));
    // bob's email must resolve to BOB, not alice. Fresh flow: the alice
    // login above CONSUMED its pending authorization (single-use), so the
    // next POST needs a brand-new pending cookie.
    const start2 = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid&state=st-em2&nonce=n-em2&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.equal(start2.status, 200);
    const badUser = await submit(cookieOf(start2), 'bob@example.com', 'correct-horse-battery-staples');
    assert.equal(badUser.status, 200);
    assert.match(badUser.body, /Wrong username or password/);
  });

  test('login form label invites either identifier; unknown identifier re-renders with the value echoed', async () => {
    const verifier = 'u'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const start = await request('GET', `/authorize?client_id=note-haven-dev&redirect_uri=${encodeURIComponent(DEV_CLIENT.redirect_uris[0])}&response_type=code&scope=openid&state=st-lbl&nonce=n-lbl&code_challenge=${challenge}&code_challenge_method=S256`);
    assert.match(start.body, /Username or email/);
    const cookieOf = (res) => String(res.headers['set-cookie'] ?? '').split(';').find((c) => c.startsWith('nh_pending=')) ?? '';
    const res = await request('POST', '/authorize/submit', { body: 'username=nobody%40example.com&password=x', raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieOf(start) } });
    assert.equal(res.status, 200);
    assert.match(res.body, /Wrong username or password/);
    // The submitted identifier is echoed back into the field (usability).
    assert.match(res.body, /value="nobody@example\.com"/);
  });
});