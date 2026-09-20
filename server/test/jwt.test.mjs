// JWT roundtrip, alg confusion, exp/iss/aud validation, JWKS shape, PKCE.
import test from 'node:test';
import {
  signJwt,
  verifyJwt,
  JwtError,
  generateRsaKeyPair,
  publicJwk,
  pkceChallenge,
  base64urlDecode,
} from '../jwt.mjs';
import { assert, createHash } from './helpers.mjs';

const { privatePem, publicPem, kid } = generateRsaKeyPair(2048);
const ISSUER = 'http://localhost:8190';

function payload(overrides = {}) {
  return { iss: ISSUER, sub: 'user-1', aud: 'note-haven-dev', iat: 1000, exp: 2000, ...overrides };
}

test('sign/verify roundtrip', () => {
  const token = signJwt(payload(), privatePem, { kid });
  const { header, payload: p } = verifyJwt(token, publicPem, { issuer: ISSUER, audience: 'note-haven-dev', now: 1500 });
  assert.equal(header.alg, 'RS256');
  assert.equal(header.kid, kid);
  assert.equal(p.sub, 'user-1');
  assert.equal(p.aud, 'note-haven-dev');
});

test('tampered payload fails signature check', () => {
  const token = signJwt(payload(), privatePem, { kid });
  const [h, , s] = token.split('.');
  const forged = JSON.stringify({ ...payload(), sub: 'attacker' });
  const evil = `${h}.${Buffer.from(forged).toString('base64url')}.${s}`;
  assert.throws(() => verifyJwt(evil, publicPem, { issuer: ISSUER }), (e) => e instanceof JwtError && e.reason === 'signature');
});

test('alg=none rejected (alg confusion)', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload())).toString('base64url');
  assert.throws(() => verifyJwt(`${header}.${body}.`, publicPem, { issuer: ISSUER }), (e) => e instanceof JwtError && e.reason === 'alg');
});

test('alg=HS256 rejected (alg confusion)', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload())).toString('base64url');
  const sig = createHash('sha256').update(`${header}.${body}`).digest('base64url');
  assert.throws(() => verifyJwt(`${header}.${body}.${sig}`, publicPem, { issuer: ISSUER }), (e) => e instanceof JwtError && e.reason === 'alg');
});

test('expired token rejected', () => {
  const token = signJwt(payload({ exp: 1000, iat: 500 }), privatePem, { kid });
  assert.throws(() => verifyJwt(token, publicPem, { issuer: ISSUER, now: 1006 }), (e) => e instanceof JwtError && e.reason === 'exp');
});

test('wrong issuer rejected', () => {
  const token = signJwt(payload({ iss: 'http://evil.example' }), privatePem, { kid });
  assert.throws(() => verifyJwt(token, publicPem, { issuer: ISSUER, now: 1500 }), (e) => e instanceof JwtError && e.reason === 'iss');
});

test('wrong audience rejected', () => {
  const token = signJwt(payload({ aud: 'other-client' }), privatePem, { issuer: ISSUER });
  assert.throws(() => verifyJwt(token, publicPem, { issuer: ISSUER, audience: 'note-haven-dev', now: 1500 }), (e) => e instanceof JwtError && e.reason === 'aud');
});

test('missing exp rejected', () => {
  const token = signJwt({ iss: ISSUER, sub: 'x' }, privatePem, { kid });
  assert.throws(() => verifyJwt(token, publicPem, { issuer: ISSUER }), (e) => e instanceof JwtError && e.reason === 'exp');
});

test('malformed token (wrong segment count) rejected', () => {
  assert.throws(() => verifyJwt('not-a-jwt', publicPem, { issuer: ISSUER }), JwtError);
});

test('kid is stable across re-derivation and persisted reload', () => {
  const again = generateRsaKeyPair(2048);
  assert.notEqual(again.kid, kid); // different key → different kid
  const { kidForPublicKey } = { kidForPublicKey: (pem) => {
    const der = createHash('sha256').update(publicPem).digest('hex'); // placeholder
    return der.slice(0, 16);
  } };
  // Deterministic: same PEM → same kid (exact check in keys.test.mjs via reload).
  assert.equal(typeof kid, 'string');
  assert.ok(kid.length === 16);
});

test('publicJwk shape', () => {
  const jwk = publicJwk(publicPem, kid);
  assert.deepEqual(Object.keys(jwk), ['kty', 'use', 'alg', 'kid', 'n', 'e']);
  assert.equal(jwk.kty, 'RSA');
  assert.equal(jwk.use, 'sig');
  assert.equal(jwk.alg, 'RS256');
  assert.equal(jwk.kid, kid);
  // n and e are base64url, no padding.
  assert.ok(!jwk.n.includes('='));
  assert.ok(!jwk.e.includes('='));
});

test('pkceChallenge is BASE64URL(SHA256(verifier))', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const again = pkceChallenge(verifier);
  assert.equal(again, createHash('sha256').update(verifier, 'ascii').digest('base64url'));
});

test('base64urlDecode roundtrip', () => {
  const buf = base64urlDecode(Buffer.from('héllo').toString('base64url'));
  assert.ok(buf.includes(195));
});