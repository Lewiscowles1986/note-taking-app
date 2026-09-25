// Shared in-memory test harness: a fake store with an in-memory FS, so tests
// never touch disk or the network.
import { randomUUID, createHash, createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { Store } from '../store.mjs';
import { SessionManager, hashPassword } from '../authn.mjs';
import { OidcService, discoveryDocument, SCOPES_SUPPORTED } from '../oidc.mjs';
import { generateRsaKeyPair } from '../jwt.mjs';
import { DEV_USERS, DEV_CLIENT, DEV_CLIENT_PUBLIC } from '../seed.mjs';
import { buildConfig } from '../config.mjs';

// Deterministic in-memory stand-in for fs-utils writeAtomic/writeSync.
export function memoryIo() {
  const files = new Map();
  return {
    files,
    writeAsync: async (p, data) => {
      files.set(p, data);
    },
    writeSync: (p, data) => {
      files.set(p, data);
    },
  };
}

const FIXED_NOW = new Date('2026-09-20T12:00:00.000Z');

export function makeStore() {
  return new Store('/unused/data-dir', { io: memoryIo(), now: () => FIXED_NOW });
}

export function seedUsers(store) {
  for (const seed of DEV_USERS) {
    const { salt, hash } = hashPassword(seed.password);
    store.upsertUser({
      sub: randomUUID(),
      username: seed.username,
      email: seed.email,
      name: seed.name,
      salt,
      hash,
      created_at: FIXED_NOW.toISOString(),
    });
  }
}

export function makeOidc({ store = makeStore(), users = true, config } = {}) {
  if (users && store.findUserByUsername('alice') === null) seedUsers(store);
  // Mirror store.load()'s client seeding: the dev client always exists.
  if (!store.clients.has(DEV_CLIENT.client_id)) {
    store.clients.set(DEV_CLIENT.client_id, { ...DEV_CLIENT });
  }
  if (!store.clients.has(DEV_CLIENT_PUBLIC.client_id)) {
    store.clients.set(DEV_CLIENT_PUBLIC.client_id, { ...DEV_CLIENT_PUBLIC });
  }
  const keys = generateRsaKeyPair(2048);
  const sessions = new SessionManager({ secret: keys.privatePem, ttlSeconds: 3600 });
  const cfg = config ?? buildConfig({ args: { issuer: 'http://localhost:8190' } });
  const oidc = new OidcService({ issuer: cfg.issuer, store, keys, sessions, config: cfg });
  return { store, oidc, keys, sessions, config: cfg };
}

// Issue a code for alice directly (bypasses the HTTP layer).
export function issueCode(oidc, { clientId = DEV_CLIENT.client_id, sub, scope = 'openid offline_access notes.sync', challenge } = {}) {
  if (!sub) {
    const user = oidc.store.findUserByUsername('alice');
    sub = user.sub;
  }
  const code = `code-${randomUUID()}`;
  oidc.codes.set(code, {
    sub,
    clientId,
    redirectUri: (oidc.store.getClient(clientId) ?? DEV_CLIENT).redirect_uris[0],
    scope,
    nonce: null,
    challenge,
    expiresAt: Date.now() + 600_000,
    used: false,
  });
  return code;
}

export function verifierAndChallenge() {
  const verifier = createHash('sha256').update(String(Math.random())).digest('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

// Fake req/res objects good enough for the HTTP-shaped handlers.
export function fakeReq({ method = 'GET', url = '/', headers = {}, cookies = {} } = {}) {
  const h = { ...headers };
  return {
    method,
    url,
    headers: h,
    parsedCookies: cookies,
    on() {},
    off() {},
    once() {},
    resume() {},
  };
}

export function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    finished: false,
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[name.toLowerCase()];
    },
    end(chunk) {
      this.finished = true;
      if (chunk) this.body = Buffer.concat([this.body ?? Buffer.alloc(0), Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
      return this;
    },
  };
  return res;
}

export { assert, createHash, createHmac, discoveryDocument, SCOPES_SUPPORTED, DEV_USERS, DEV_CLIENT, DEV_CLIENT_PUBLIC };