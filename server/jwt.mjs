// Minimal JOSE toolkit built on node:crypto — RS256 (RSASSA-PKCS1-v1_5 with
// SHA-256) JWT signing/verification, base64url helpers, JWK export, and the
// S256 PKCE challenge computation. No third-party dependencies.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export function base64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

export function base64urlDecode(input) {
  return Buffer.from(String(input), 'base64url');
}

export function sha256Base64Url(input) {
  return createHash('sha256').update(String(input), 'ascii').digest('base64url');
}

// S256 PKCE challenge: BASE64URL(SHA256(ASCII(code_verifier))) — RFC 7636
// §4.2, computed with a constant digest so comparison can be timing-safe.
export function pkceChallenge(verifier) {
  return sha256Base64Url(verifier);
}

// --- key management ---------------------------------------------------------

// The key id is derived from the RSA public key itself (SHA-256 of the DER
// SubjectPublicKeyInfo, first 16 hex chars) so it stays stable across
// restarts even though the key pair is stored as PEM text.
export function kidForPublicKey(publicKey) {
  // Accepts a PEM string or a JWK object. (Node 26 quirk: createPublicKey
  // rejects an already-built public KeyObject in some call paths, so we always
  // go through serialised form.)
  const der = createPublicKey(publicKey).export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateRsaKeyPair(modulusLength = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength });
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return {
    kid: kidForPublicKey(publicPem),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem,
  };
}

// Export an RSA public key as a JWK suitable for GET /.well-known/jwks.json.
export function publicJwk(publicPem, kid) {
  const jwk = createPublicKey(publicPem).export({ format: 'jwk' });
  // Sort keys for deterministic output; only RSA signing fields are exposed.
  return {
    kty: jwk.kty,
    use: 'sig',
    alg: 'RS256',
    kid,
    n: jwk.n,
    e: jwk.e,
  };
}

// --- JWT --------------------------------------------------------------------

function b64Json(value) {
  return base64urlEncode(JSON.stringify(value));
}

export function signJwt(payload, privatePem, { kid, extraHeader = {} } = {}) {
  const header = { alg: 'RS256', typ: 'JWT', ...extraHeader };
  if (kid) header.kid = kid;
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), createPrivateKey(privatePem));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export class JwtError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'JwtError';
    this.reason = reason;
  }
}

// Strict RS256-only verification. `header.alg` MUST be exactly 'RS256' —
// anything else (including 'none' or HS256) is rejected before any crypto is
// attempted, closing the algorithm-confusion attack.
export function verifyJwt(token, publicPem, {
  issuer,
  audience,
  now = Math.floor(Date.now() / 1000),
  clockTolerance = 5,
} = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed token', { reason: 'malformed' });
  }
  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch {
    throw new JwtError('token segments are not valid base64url JSON', { reason: 'malformed' });
  }
  if (header?.alg !== 'RS256') {
    throw new JwtError(`unexpected alg ${JSON.stringify(header?.alg)}; only RS256 is accepted`, { reason: 'alg' });
  }
  if (header?.typ !== undefined && header.typ !== 'JWT') {
    throw new JwtError('unexpected typ', { reason: 'typ' });
  }
  const signingInput = `${parts[0]}.${parts[1]}`;
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(signingInput, 'ascii'),
    createPublicKey(publicPem),
    base64urlDecode(parts[2]),
  );
  if (!ok) {
    throw new JwtError('signature verification failed', { reason: 'signature' });
  }
  if (typeof payload.exp !== 'number') {
    throw new JwtError('token has no exp claim', { reason: 'exp' });
  }
  if (now - clockTolerance > payload.exp) {
    throw new JwtError('token expired', { reason: 'exp' });
  }
  if (typeof payload.iss !== 'string' || (issuer !== undefined && payload.iss !== issuer)) {
    throw new JwtError(`unexpected iss ${JSON.stringify(payload.iss)}`, { reason: 'iss' });
  }
  if (audience !== undefined) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(audience)) {
      throw new JwtError('unexpected aud', { reason: 'aud' });
    }
  }
  return { header, payload };
}