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
    expect(byteLength(payload.mac!)).toBe(32); // HMAC-SHA-256 tag
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
    // Deterministic thanks to the encrypt-then-MAC tag — AES-CBC alone only
    // caught this ~255/256 of the time (valid-PKCS#7-by-chance flakes).
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow(/integrity/i);
  });

  it('rejects tampered ciphertext on the FIRST block too', async () => {
    // Multi-block payload: flip a byte in the first block (not just the final
    // padding block) — the MAC covers the whole ciphertext.
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    const bytes = Uint8Array.from(atob(payload.ciphertext), (ch) => ch.charCodeAt(0));
    bytes[0] ^= 0xff;
    const tampered: EncryptedPayload = { ...payload, ciphertext: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow(/integrity/i);
  });

  it('rejects a tampered MAC', async () => {
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    const tampered: EncryptedPayload = { ...payload, mac: flipLastByte(payload.mac!) };
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow(/integrity/i);
  });

  it('decrypts a legacy payload without a mac field (backward compatible)', async () => {
    // Payloads from before the integrity layer have no `mac`; they must keep
    // decrypting so existing stored notes and old exports remain readable.
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    const { mac: _omitted, ...legacy } = payload;
    expect('mac' in legacy).toBe(false);
    await expect(decryptWithPassword(legacy, PASSWORD)).resolves.toBe(PLAINTEXT);
  });

  it('rejects a tampered IV', async () => {
    // The MAC covers the IV, so tampering is rejected deterministically —
    // regardless of which block the flipped byte lands in.
    const payload = await encryptWithPassword(PLAINTEXT, PASSWORD);
    const tampered: EncryptedPayload = { ...payload, iv: flipLastByte(payload.iv) };
    await expect(decryptWithPassword(tampered, PASSWORD)).rejects.toThrow(/integrity/i);
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
    expect(byteLength(payload.mac!)).toBe(32); // HMAC-SHA-256 tag
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
    // Deterministic via the MAC over iv‖ciphertext‖wrappedKey.
    await expect(decryptWithPrivateKey(tampered, kp.privateKeyJwk)).rejects.toThrow(/integrity/i);
  });

  it('rejects a tampered wrapped AES key (key substitution)', async () => {
    const payload = await encryptWithPublicKey('secret', kp.publicKeyJwk);
    const tampered: EncryptedPayload = {
      ...payload,
      wrappedKey: flipLastByte(payload.wrappedKey!),
    };
    await expect(decryptWithPrivateKey(tampered, kp.privateKeyJwk)).rejects.toThrow();
  });

  it('rejects a tampered MAC on a keypair payload', async () => {
    const payload = await encryptWithPublicKey('secret', kp.publicKeyJwk);
    const tampered: EncryptedPayload = { ...payload, mac: flipLastByte(payload.mac!) };
    await expect(decryptWithPrivateKey(tampered, kp.privateKeyJwk)).rejects.toThrow(/integrity/i);
  });

  it('decrypts a legacy keypair payload without a mac field (backward compatible)', async () => {
    const payload = await encryptWithPublicKey('secret', kp.publicKeyJwk);
    const { mac: _omitted, ...legacy } = payload;
    await expect(decryptWithPrivateKey(legacy, kp.privateKeyJwk)).resolves.toBe('secret');
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