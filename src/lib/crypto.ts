/**
 * Client-side encryption for notes.
 *
 * Password-based:  PBKDF2 → AES-256-CBC
 * Key-pair-based:  RSA-OAEP wraps a random AES-256-CBC key
 *
 * All operations use the Web Crypto API — no external deps.
 */

// ─── helpers ────────────────────────────────────────────────────

function ab2b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b642ab(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

// ─── types ──────────────────────────────────────────────────────

export interface EncryptedPayload {
  /** 'password' | 'keypair' */
  method: 'password' | 'keypair';
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded IV (16 bytes for AES-CBC) */
  iv: string;
  /** Base64-encoded PBKDF2 salt (password method only) */
  salt?: string;
  /** Base64-encoded RSA-OAEP encrypted AES key (keypair method only) */
  wrappedKey?: string;
  /** Fingerprint (SHA-256 of public key) identifying which key pair was used */
  keyFingerprint?: string;
}

// ─── password-based encryption (AES-256-CBC + PBKDF2) ───────────

const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(password: string, salt: ArrayBuffer): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-CBC', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptWithPassword(
  plaintext: string,
  password: string,
): Promise<EncryptedPayload> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt.buffer as ArrayBuffer);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: iv.buffer as ArrayBuffer },
    key,
    enc.encode(plaintext),
  );
  return {
    method: 'password',
    ciphertext: ab2b64(ciphertext),
    iv: ab2b64(iv.buffer as ArrayBuffer),
    salt: ab2b64(salt.buffer as ArrayBuffer),
  };
}

export async function decryptWithPassword(
  payload: EncryptedPayload,
  password: string,
): Promise<string> {
  const salt = b642ab(payload.salt!);
  const iv = b642ab(payload.iv);
  const key = await deriveKey(password, salt);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    key,
    b642ab(payload.ciphertext),
  );
  return new TextDecoder().decode(plain);
}

// ─── key-pair-based encryption (RSA-OAEP + AES-256-CBC) ─────────

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: 'RSA-OAEP',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

export interface StoredKeyPair {
  id: string;
  name: string;
  fingerprint: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  createdAt: Date;
}

export async function generateKeyPair(name: string): Promise<StoredKeyPair> {
  const pair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['wrapKey', 'unwrapKey']);
  const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const fingerprint = await getKeyFingerprint(pubJwk);
  return {
    id: crypto.randomUUID(),
    name,
    fingerprint,
    publicKeyJwk: pubJwk,
    privateKeyJwk: privJwk,
    createdAt: new Date(),
  };
}

export async function getKeyFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(publicKeyJwk)));
  return ab2b64(hash).slice(0, 16);
}

export async function encryptWithPublicKey(
  plaintext: string,
  publicKeyJwk: JsonWebKey,
): Promise<EncryptedPayload> {
  const enc = new TextEncoder();
  // Generate random AES key
  const aesKey = await crypto.subtle.generateKey({ name: 'AES-CBC', length: 256 }, true, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    aesKey,
    enc.encode(plaintext),
  );

  // Wrap AES key with RSA public key
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['wrapKey'],
  );
  const wrappedKey = await crypto.subtle.wrapKey('raw', aesKey, publicKey, { name: 'RSA-OAEP' });

  const fingerprint = await getKeyFingerprint(publicKeyJwk);

  return {
    method: 'keypair',
    ciphertext: ab2b64(ciphertext),
    iv: ab2b64(iv.buffer as ArrayBuffer),
    wrappedKey: ab2b64(wrappedKey),
    keyFingerprint: fingerprint,
  };
}

export async function decryptWithPrivateKey(
  payload: EncryptedPayload,
  privateKeyJwk: JsonWebKey,
): Promise<string> {
  const iv = new Uint8Array(b642ab(payload.iv));
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['unwrapKey'],
  );
  const aesKey = await crypto.subtle.unwrapKey(
    'raw',
    b642ab(payload.wrappedKey!),
    privateKey,
    { name: 'RSA-OAEP' },
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, b642ab(payload.ciphertext));
  return new TextDecoder().decode(plain);
}

// ─── PEM import / export helpers ────────────────────────────────

function pemToJwk(pem: string, type: 'public' | 'private'): Promise<JsonWebKey> {
  const header = type === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY';
  const b64 = pem
    .replace(`-----BEGIN ${header}-----`, '')
    .replace(`-----END ${header}-----`, '')
    .replace(/\s/g, '');
  const buf = b642ab(b64);
  const format = type === 'public' ? 'spki' : 'pkcs8';
  const usages: KeyUsage[] = type === 'public' ? ['wrapKey'] : ['unwrapKey'];
  return crypto.subtle
    .importKey(format, buf, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, usages)
    .then((key) => crypto.subtle.exportKey('jwk', key));
}

export async function importPemKeyPair(
  name: string,
  publicPem: string,
  privatePem: string,
): Promise<StoredKeyPair> {
  const publicKeyJwk = await pemToJwk(publicPem, 'public');
  const privateKeyJwk = await pemToJwk(privatePem, 'private');
  const fingerprint = await getKeyFingerprint(publicKeyJwk);
  return {
    id: crypto.randomUUID(),
    name,
    fingerprint,
    publicKeyJwk,
    privateKeyJwk,
    createdAt: new Date(),
  };
}

export async function importJwkKeyPair(
  name: string,
  publicKeyJwk: JsonWebKey,
  privateKeyJwk: JsonWebKey,
): Promise<StoredKeyPair> {
  const fingerprint = await getKeyFingerprint(publicKeyJwk);
  return {
    id: crypto.randomUUID(),
    name,
    fingerprint,
    publicKeyJwk,
    privateKeyJwk,
    createdAt: new Date(),
  };
}

export async function exportKeyPairAsJwk(
  kp: StoredKeyPair,
): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  return { publicKey: kp.publicKeyJwk, privateKey: kp.privateKeyJwk };
}

async function jwkToPem(jwk: JsonWebKey, type: 'public' | 'private'): Promise<string> {
  const format = type === 'public' ? 'spki' : 'pkcs8';
  const usages: KeyUsage[] = type === 'public' ? ['wrapKey'] : ['unwrapKey'];
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    true,
    usages,
  );
  const buf = await crypto.subtle.exportKey(format, key);
  const header = type === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY';
  const b64 = ab2b64(buf);
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${header}-----\n${lines.join('\n')}\n-----END ${header}-----`;
}

export async function exportKeyPairAsPem(
  kp: StoredKeyPair,
): Promise<{ publicPem: string; privatePem: string }> {
  const publicPem = await jwkToPem(kp.publicKeyJwk, 'public');
  const privatePem = await jwkToPem(kp.privateKeyJwk, 'private');
  return { publicPem, privatePem };
}
