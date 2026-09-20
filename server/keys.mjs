// Key management for the OIDC provider: one RS256 key pair, generated on
// first boot, persisted to data/keys.json, and reused on every restart so the
// `kid` (derived from the public key) stays stable and cached JWKS stay valid.
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateRsaKeyPair, kidForPublicKey } from './jwt.mjs';
import { createPublicKey } from 'node:crypto';

// `io.write` is injectable for tests.
export async function loadOrCreateKeys(dataDir, { io = { write: writeFile } } = {}) {
  const file = path.join(dataDir, 'keys.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed?.kid && parsed?.privatePem && parsed?.publicPem) {
        // Sanity: recompute kid from the stored public key; regenerate if the
        // file was tampered with.
        const actualKid = kidForPublicKey(parsed.publicPem);
        if (actualKid === parsed.kid) {
          return { kid: parsed.kid, privatePem: parsed.privatePem, publicPem: parsed.publicPem, persisted: true };
        }
        console.warn('[keys] keys.json kid mismatch; regenerating key pair');
      }
    } catch {
      console.warn('[keys] keys.json unreadable; regenerating key pair');
    }
  }
  const keys = generateRsaKeyPair(2048);
  await io.write(file, JSON.stringify(keys, null, 2) + '\n');
  return { ...keys, persisted: false };
}

export function jwksDocument(keys) {
  return { keys: [publicJwkFromPem(keys.publicPem, keys.kid)] };
}

export function publicJwkFromPem(publicPem, kid) {
  // Import from PEM string (Node 26 rejects public KeyObject inputs here).
  const jwk = createPublicKey(publicPem).export({ format: 'jwk' });
  return { kty: jwk.kty, use: 'sig', alg: 'RS256', kid, n: jwk.n, e: jwk.e };
}