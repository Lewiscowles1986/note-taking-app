import { beforeAll, describe, expect, it } from 'vitest';
import {
  decryptWithPassword,
  decryptWithPrivateKey,
  encryptWithPassword,
  encryptWithPublicKey,
  exportKeyPairAsJwk,
  exportKeyPairAsPem,
  generateKeyPair,
  getKeyFingerprint,
  importJwkKeyPair,
  importPemKeyPair,
  type EncryptedPayload,
  type StoredKeyPair,
} from '@/lib/crypto';

// RSA-4096 keygen is CPU-bound and can spike on loaded machines.
const RSA_TIMEOUT = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_RE = /^[A-Za-z0-9+/]{16}$/;

/** Flip the final byte of a base64 field (targets the last AES-CBC block). */
function flipLastByte(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff;
  return btoa(String.fromCharCode(...bytes));
}

/** Byte length of a base64 field. */
function byteLength(base64: string): number {
  return atob(base64).length;
}

describe('password-based encryption (PBKDF2 + AES-256-CBC)', () => {
  const PASSWORD = 'correct horse battery staple';
  const PLAINTEXT = 'Top secret meeting notes 🔐 — 加密ノート';

  it('round-trips a plaintext and returns a well-formed password payload', async () => {
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    expect(payload.method).toBe('password');
    expect(payload.wrappedKey).toBeUndefined();
    expect(payload.keyFingerprint).toBeUndefined();
    expect(byteLength(payload.iv)).toBe(16); // AES-CBC IV
    expect(byteLength(payload.salt!)).toBe(32); // PBKDF2 salt
    expect(byteLength(payload.ciphertext)).toBeGreaterThan(0);
    expect(byteLength(payload.ciphertext) % 16).toBe(0); // AES block alignment
    await expect(decryptWithPassword(payload, PASSWORD)).resolves.toBe(PLAINTEXT);
  });

  it('round-trips an empty string', async () => {
    const payload = await encryptWithPassword('', PASSWORD);
    expect(byteLength(payload.ciphertext)).toBe(16); // padding-only block
    await expect(decryptWithPassword(payload, PASSWORD)).resolves.toBe('');
  });

  it('round-trips a ~100KB payload', async () => {
    const chunk = 'Note Haven encrypts this long note in the browser. ';
    const large = chunk.repeat(3000).slice(0, 100 * 1024); // 100 KiB of text
    const payload = await encryptWithPassword(large, PASSWORD);
    await expect(decryptWithPassword(payload, PASSWORD)).resolves.toBe(large);
  });

  it('rejects decryption with the wrong password', async () => {
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    await expect(decryptWithPassword(payload, 'wrong password')).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    const tampered: EncryptedPayload = { ...payload, ciphertext: flipLastByte(payload.ciphertext) };
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow();
  });

  it('rejects a tampered IV', async () => {
    // Single-block ciphertext ('short' → one AES block) so the corrupted IV is
    // the only input to the final padding block; flipping its last byte turns
    // the PKCS#7 pad byte into 0xF4, which is deterministically invalid.
    const payload = await encryptWithPassword('short', PASSWORD);
    const tampered: EncryptedPayload = { ...payload, iv: flipLastByte(payload.iv) };
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow();
  });

  it('rejects a tampered salt (different derived key)', async () => {
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    const tampered: EncryptedPayload = { ...payload, salt: flipLastByte(payload.salt!) };
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow();
  });

  it('rejects a payload without a salt field', async () => {
    const payload = await encryptWithPassword('short', PASSWORD);
    const missingSalt: EncryptedPayload = {
      method: 'password',
      ciphertext: payload.ciphertext,
      iv: payload.iv,
    };
    await expect(decryptWithPassword(missingSalt, PASSWORD)).rejects.toThrow();
  });

  it('rejects malformed base64 in payload fields', async () => {
    const payload = await encryptWithPassword('short', PASSWORD);
    const malformed: EncryptedPayload = { ...payload, ciphertext: 'not!!base64' };
    await expect(decryptWithPassword(malformed, PASSWORD)).rejects.toThrow();
  });
});

describe('key-pair based encryption (RSA-OAEP + AES-256-CBC)', () => {
  let kp: StoredKeyPair;
  let otherKp: StoredKeyPair;
  let pems: { publicPem: string; privatePem: string };
  let importedFromPem: StoredKeyPair;

  beforeAll(async () => {
    kp = await generateKeyPair('Personal key');
    otherKp = await generateKeyPair('Work key');
    pems = await exportKeyPairAsPem(kp);
    importedFromPem = await importPemKeyPair('Imported PEM key', pems.publicPem, pems.privatePem);
  }, RSA_TIMEOUT);

  it('generateKeyPair returns a storable RSA key pair', () => {
    expect(kp.name).toBe('Personal key');
    expect(kp.id).toMatch(UUID_RE);
    expect(kp.createdAt).toBeInstanceOf(Date);
    expect(kp.fingerprint).toMatch(FINGERPRINT_RE);
    expect(kp.publicKeyJwk.kty).toBe('RSA');
    expect(kp.publicKeyJwk.n).toBeDefined();
    expect(kp.publicKeyJwk.e).toBeDefined();
    expect(kp.privateKeyJwk.d).toBeDefined();
    expect(kp.privateKeyJwk.p).toBeDefined();
    expect(kp.privateKeyJwk.q).toBeDefined();
  });

  it('getKeyFingerprint is deterministic and matches the generated pair', async () => {
    expect(kp.fingerprint).toHaveLength(16);
    await expect(getKeyFingerprint(kp.publicKeyJwk)).resolves.toBe(kp.fingerprint);
    await expect(getKeyFingerprint(kp.publicKeyJwk)).resolves.toBe(kp.fingerprint);
  });

  it('assigns different fingerprints to independent key pairs', () => {
    expect(otherKp.name).toBe('Work key');
    expect(otherKp.id).not.toBe(kp.id);
    expect(otherKp.fingerprint).not.toBe(kp.fingerprint);
  });

  it('encrypts with the public key and decrypts with the private key', async () => {
    const secret = '🔐 RSA-wrapped note — 暗号化';
    const payload = await encryptWithPublicKey(secret, kp.publicKeyJwk);
    expect(payload.method).toBe('keypair');
    expect(payload.salt).toBeUndefined();
    expect(payload.wrappedKey).toBeDefined();
    expect(payload.keyFingerprint).toBe(kp.fingerprint);
    await expect(decryptWithPrivateKey(payload, kp.privateKeyJwk)).resolves.toBe(secret);
  });

  it('round-trips an empty plaintext through the key pair', async () => {
    const payload = await encryptWithPublicKey('', kp.publicKeyJwk);
    await expect(decryptWithPrivateKey(payload, kp.privateKeyJwk)).resolves.toBe('');
  });

  it('rejects a tampered wrapped AES key', async () => {
    const payload = await encryptWithPublicKey('secret', kp.publicKeyJwk);
    const tampered: EncryptedPayload = {
      ...payload,
      wrappedKey: flipLastByte(payload.wrappedKey!),
    };
    await expect(decryptWithPrivateKey(tampered, kp.privateKeyJwk)).rejects.toThrow();
  });

  it('rejects a payload without a wrapped AES key', async () => {
    const payload = await encryptWithPublicKey('secret', kp.publicKeyJwk);
    const missingWrapped: EncryptedPayload = {
      method: 'keypair',
      ciphertext: payload.ciphertext,
      iv: payload.iv,
    };
    await expect(decryptWithPrivateKey(missingWrapped, kp.privateKeyJwk)).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const payload = await encryptWithPublicKey('secret', kp.publicKeyJwk);
    const tampered: EncryptedPayload = { ...payload, ciphertext: flipLastByte(payload.ciphertext) };
    await expect(decryptWithPrivateKey(tampered, kp.privateKeyJwk)).rejects.toThrow();
  });

  it('exportKeyPairAsJwk returns the stored JWKs unchanged', async () => {
    const jwks = await exportKeyPairAsJwk(kp);
    expect(jwks).toEqual({ publicKey: kp.publicKeyJwk, privateKey: kp.privateKeyJwk });
  });

  it('exportKeyPairAsPem emits framed PEM with 64-column base64 bodies', () => {
    const cases = [
      { pem: pems.publicPem, header: 'PUBLIC KEY' },
      { pem: pems.privatePem, header: 'PRIVATE KEY' },
    ];
    for (const { pem, header } of cases) {
      expect(pem.startsWith(`-----BEGIN ${header}-----\n`)).toBe(true);
      expect(pem.endsWith(`\n-----END ${header}-----`)).toBe(true);
      const body = pem.slice(pem.indexOf('\n') + 1, pem.lastIndexOf('\n'));
      const lines = body.split('\n');
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines) {
        expect(line).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // final line carries b64 padding
        expect(line.length).toBeLessThanOrEqual(64); // 64-column wrap
      }
      expect(atob(lines.join('')).length).toBeGreaterThan(0);
    }
  });

  it('importPemKeyPair rebuilds a usable key pair from PEM', async () => {
    expect(importedFromPem.name).toBe('Imported PEM key');
    expect(importedFromPem.id).toMatch(UUID_RE);
    expect(importedFromPem.createdAt).toBeInstanceOf(Date);
    expect(importedFromPem.fingerprint).toMatch(FINGERPRINT_RE);
    expect(importedFromPem.publicKeyJwk.kty).toBe('RSA');
    expect(importedFromPem.privateKeyJwk.d).toBeDefined();
    const secret = 'recovered from PEM 🔐';
    const payload = await encryptWithPublicKey(secret, importedFromPem.publicKeyJwk);
    await expect(decryptWithPrivateKey(payload, importedFromPem.privateKeyJwk)).resolves.toBe(secret);
  });

  it('importJwkKeyPair stores the provided JWKs', async () => {
    const imported = await importJwkKeyPair('Imported JWK key', kp.publicKeyJwk, kp.privateKeyJwk);
    expect(imported.name).toBe('Imported JWK key');
    expect(imported.id).toMatch(UUID_RE);
    expect(imported.createdAt).toBeInstanceOf(Date);
    expect(imported.publicKeyJwk).toEqual(kp.publicKeyJwk);
    expect(imported.privateKeyJwk).toEqual(kp.privateKeyJwk);
    expect(imported.fingerprint).toBe(kp.fingerprint);
  });

  it('rejects a corrupted PEM body', async () => {
    await expect(importPemKeyPair('Broken', pems.publicPem, 'not-a-valid-pem')).rejects.toThrow();
  });
});