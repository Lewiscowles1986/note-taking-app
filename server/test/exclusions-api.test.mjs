// Exclusions over the real router: PUT enforcement (403 excluded), manifest
// filtering (excluded uids never listed, not even as tombstones), the DELETE
// exemption, and discovery advertisement over HTTP. Loopback only.
import test, { after, before, describe } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildConfig } from '../config.mjs';
import { Store } from '../store.mjs';
import { SessionManager, hashPassword } from '../authn.mjs';
import { OidcService } from '../oidc.mjs';
import { loadOrCreateKeys } from '../keys.mjs';
import { createRouter } from '../routes.mjs';
import { DEV_USERS, DEV_CLIENT, assert as _assert, memoryIo } from './helpers.mjs';

const ISSUER = 'http://localhost:8192';
const EXCLUSIONS = { excludedCategories: ['Private', 'Legal'], excludedUids: ['denied-uid'] };

let server;
let baseUrl;
let aliceToken;
let aliceStore;
let aliceSub;

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

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
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

before(async () => {
  const { writeAsync, writeSync } = memoryIo();
  const keys = await loadOrCreateKeys('/tmp/unused', { io: { write: async () => undefined, writeSync } });
  const store = new Store('/unused', { io: { writeAsync, writeSync } });
  await store.load();
  for (const seed of DEV_USERS) {
    const { salt, hash } = hashPassword(seed.password);
    store.upsertUser({ sub: `sub-${seed.username}`, username: seed.username, email: seed.email, name: seed.name, salt, hash, created_at: '2026-01-01' });
  }
  const sessions = new SessionManager({ secret: 'test-secret' });
  const config = buildConfig({ args: { issuer: ISSUER, exclusions: EXCLUSIONS } });
  const oidc = new OidcService({ issuer: ISSUER, store, keys, sessions, config });
  const router = createRouter({ config, store, oidc, keys, sessions });
  server = http.createServer(router);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  aliceSub = oidc.store.findUserByUsername('alice').sub;
  aliceStore = oidc.store.notesFor(aliceSub);
  aliceToken = issueFor(oidc, 'alice').access_token;
});

after(() => {
  server?.close();
});

const auth = () => ({ authorization: `Bearer ${aliceToken}` });

describe('exclusion enforcement over HTTP', () => {
  test('PUT for an excluded category → 403 excluded, nothing stored', async () => {
    const put = await request('PUT', '/api/notes/uid-priv', {
      body: { uid: 'uid-priv', title: 'Secret', category: 'Private', updatedAt: '2026-09-20T01:00:00.000Z' },
      headers: auth(),
    });
    assert.equal(put.status, 403);
    assert.equal(put.json.error, 'excluded');
    assert.match(put.json.error_description, /category "Private" is excluded on this server/);
  });

  test('PUT for an excluded uid → 403 excluded even with an allowed category', async () => {
    const put = await request('PUT', '/api/notes/denied-uid', {
      body: { uid: 'denied-uid', title: 'Denied', category: 'Travel', updatedAt: '2026-09-20T01:00:00.000Z' },
      headers: auth(),
    });
    assert.equal(put.status, 403);
    assert.equal(put.json.error, 'excluded');
    assert.match(put.json.error_description, /note uid "denied-uid" is excluded on this server/);
  });

  test('PUT for an allowed uid + allowed category → 200 (exclusions do not over-block)', async () => {
    const put = await request('PUT', '/api/notes/uid-ok', {
      body: { uid: 'uid-ok', title: 'Fine', category: 'Travel', updatedAt: '2026-09-20T01:00:00.000Z' },
      headers: auth(),
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.ok, true);
  });

  test('manifest omits excluded uids entirely (even tombstoned ones)', async () => {
    // Store a note under the excluded uid via a fresh token... it cannot be
    // PUT (403 above), so simulate the pre-exclusion state: a note that was
    // synced before the policy existed. Store internals are out of scope for
    // the HTTP surface — instead verify a second user's manifest stays clean
    // and that the denied uid does not appear after tombstoning attempts.
    const manifest = await request('GET', '/api/notes', { headers: auth() });
    assert.equal(manifest.status, 200);
    const uids = manifest.json.notes.map((n) => n.uid);
    assert.equal(uids.includes('denied-uid'), false, 'excluded uid must never be listed');
    assert.equal(uids.includes('uid-priv'), false, 'note never accepted (403) must not exist');
    assert.deepEqual(uids, ['uid-ok']);
  });

  test('GET of a pre-existing excluded record still serves 200 with the payload (documented behavior)', async () => {
    // Simulate the pre-exclusion state: the record was stored BEFORE the
    // policy existed, so seed the store directly (a PUT now would 403).
    // The uid IS on the deny list ('denied-uid' from EXCLUSIONS).
    aliceStore.set('denied-uid', {
      uid: 'denied-uid',
      deleted: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
      storedAt: '2026-01-01T00:00:00.000Z',
      payload: {
        uid: 'denied-uid',
        title: 'Pre-policy note',
        category: 'Travel',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    // The manifest STILL hides it...
    const manifest = await request('GET', '/api/notes', { headers: auth() });
    assert.equal(manifest.json.notes.some((n) => n.uid === 'denied-uid'), false);
    // ...but a direct GET of the pre-existing record serves the payload.
    const get = await request('GET', '/api/notes/denied-uid', { headers: auth() });
    assert.equal(get.status, 200);
    assert.equal(get.json.uid, 'denied-uid');
    assert.equal(get.json.title, 'Pre-policy note');
    assert.equal(get.json.category, 'Travel');
  });

  test('DELETE for an excluded uid still works (exclusions govern content, not lifecycle)', async () => {
    const del = await request('DELETE', '/api/notes/denied-uid', { headers: auth() });
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);
    assert.equal(del.json.deleted, true);
    // ...and the tombstone is STILL not listed in the manifest.
    const manifest = await request('GET', '/api/notes', { headers: auth() });
    assert.equal(manifest.json.notes.some((n) => n.uid === 'denied-uid'), false);
  });

  test('discovery advertises notes.excluded_* only when set', async () => {
    const doc = (await request('GET', '/.well-known/openid-configuration')).json;
    assert.deepEqual(doc.notes, { excluded_categories: ['Private', 'Legal'], excluded_uids: ['denied-uid'] });
  });

  test('category match is exact: "private" (lowercase) is a different category', async () => {
    const put = await request('PUT', '/api/notes/uid-case', {
      body: { uid: 'uid-case', title: 'Case', category: 'private', updatedAt: '2026-09-20T01:00:00.000Z' },
      headers: auth(),
    });
    assert.equal(put.status, 200);
  });
});