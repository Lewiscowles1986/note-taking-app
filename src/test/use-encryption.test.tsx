import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exportKeyPairAsPem,
  generateKeyPair,
  type EncryptedPayload,
  type StoredKeyPair,
} from "@/lib/crypto";
import { db, saveKeyPair } from "@/lib/db";
import { useEncryption } from "@/hooks/useEncryption";

// RSA-4096 keygen and PBKDF2 (600k iterations) are CPU-bound.
const CRYPTO_TIMEOUT = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT_RE = /^[A-Za-z0-9+/]{16}$/;

/** Wipe the real database and reopen it fresh at the current (v4) schema. */
async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

/** A synthetic stored pair for the mount-load test (avoids extra RSA keygen). */
function syntheticKeyPair(overrides: Partial<StoredKeyPair> = {}): StoredKeyPair {
  return {
    id: "kp-seed",
    name: "seeded",
    fingerprint: "SEEDFP0000000001",
    publicKeyJwk: { kty: "RSA", e: "AQAB", n: "c2VlZGVkLXB1YmxpYw" },
    privateKeyJwk: { kty: "RSA", d: "c2VlZGVkLXByaXZhdGU" },
    createdAt: new Date(),
    ...overrides,
  };
}

describe("useEncryption", () => {
  let baseKp: StoredKeyPair;
  let pems: { publicPem: string; privatePem: string };

  beforeAll(async () => {
    baseKp = await generateKeyPair("Base key");
    pems = await exportKeyPairAsPem(baseKp);
  }, CRYPTO_TIMEOUT);

  beforeEach(resetDb);

  it("loads existing key pairs from the database on mount", async () => {
    await saveKeyPair(syntheticKeyPair());
    const { result } = renderHook(() => useEncryption());

    await waitFor(() => expect(result.current.keyPairs).toHaveLength(1));
    expect(result.current.keyPairs[0].name).toBe("seeded");
    expect(result.current.keyPairs[0].fingerprint).toBe("SEEDFP0000000001");
  });

  it("starts empty when the database has no key pairs", async () => {
    const { result } = renderHook(() => useEncryption());

    await waitFor(() => expect(result.current.keyPairs).toEqual([]));
  });

  it("generateNewKeyPair creates, stores and exposes a real RSA key pair", async () => {
    const { result } = renderHook(() => useEncryption());

    let generated: StoredKeyPair | undefined;
    await act(async () => {
      generated = await result.current.generateNewKeyPair("Laptop");
    });

    expect(generated?.name).toBe("Laptop");
    expect(generated?.id).toMatch(UUID_RE);
    expect(generated?.fingerprint).toMatch(FINGERPRINT_RE);
    expect(generated?.publicKeyJwk.kty).toBe("RSA");
    expect(generated?.privateKeyJwk.d).toBeDefined();
    await waitFor(() => expect(result.current.keyPairs).toHaveLength(1));
    expect(result.current.keyPairs[0].name).toBe("Laptop");
  }, CRYPTO_TIMEOUT);

  it("importPem stores a usable PEM key pair", async () => {
    const { result } = renderHook(() => useEncryption());

    let imported: StoredKeyPair | undefined;
    await act(async () => {
      imported = await result.current.importPem("From PEM", pems.publicPem, pems.privatePem);
    });

    expect(imported?.name).toBe("From PEM");
    expect(imported?.id).toMatch(UUID_RE);
    expect(imported?.fingerprint).toMatch(FINGERPRINT_RE);
    expect(imported?.privateKeyJwk.d).toBeDefined();
    await waitFor(() => expect(result.current.keyPairs).toHaveLength(1));
    expect(result.current.keyPairs[0].name).toBe("From PEM");
  }, CRYPTO_TIMEOUT);

  it("importJwk stores the provided JWKs under a fresh id", async () => {
    const { result } = renderHook(() => useEncryption());

    let imported: StoredKeyPair | undefined;
    await act(async () => {
      imported = await result.current.importJwk("From JWK", baseKp.publicKeyJwk, baseKp.privateKeyJwk);
    });

    expect(imported?.name).toBe("From JWK");
    expect(imported?.id).toMatch(UUID_RE);
    expect(imported?.publicKeyJwk).toEqual(baseKp.publicKeyJwk);
    expect(imported?.privateKeyJwk).toEqual(baseKp.privateKeyJwk);
    await waitFor(() => expect(result.current.keyPairs).toHaveLength(1));
    expect(result.current.keyPairs[0].fingerprint).toBe(baseKp.fingerprint);
  }, CRYPTO_TIMEOUT);

  it("removeKeyPair deletes and refreshes; unknown ids are a no-op", async () => {
    await saveKeyPair(syntheticKeyPair());
    const { result } = renderHook(() => useEncryption());
    await waitFor(() => expect(result.current.keyPairs).toHaveLength(1));

    await act(async () => {
      await result.current.removeKeyPair("kp-seed");
    });
    expect(result.current.keyPairs).toEqual([]);

    await act(async () => {
      await result.current.removeKeyPair("ghost");
    });
    expect(result.current.keyPairs).toEqual([]);
  });

  it("encryptContent + decryptContent round-trip with a password, and reject a wrong one", async () => {
    const { result } = renderHook(() => useEncryption());

    let payload: EncryptedPayload | undefined;
    await act(async () => {
      payload = await result.current.encryptContent("top secret", "password", "correct horse");
    });
    expect(payload?.method).toBe("password");
    expect(payload?.salt).toBeDefined();

    let roundTrip = "";
    await act(async () => {
      roundTrip = await result.current.decryptContent(payload, "correct horse");
    });
    expect(roundTrip).toBe("top secret");

    await act(async () => {
      await expect(result.current.decryptContent(payload, "wrong password")).rejects.toThrow();
    });
  }, CRYPTO_TIMEOUT);

  it("encryptContent + decryptContent round-trip with a stored key pair", async () => {
    const { result } = renderHook(() => useEncryption());
    await act(async () => {
      await result.current.importJwk("Base", baseKp.publicKeyJwk, baseKp.privateKeyJwk);
    });

    let payload: EncryptedPayload | undefined;
    await act(async () => {
      payload = await result.current.encryptContent("rsa secret", "keypair", baseKp);
    });
    expect(payload?.method).toBe("keypair");
    expect(payload?.keyFingerprint).toBe(baseKp.fingerprint);
    expect(payload?.wrappedKey).toBeDefined();

    if (!payload) throw new Error("encryptContent returned no payload");
    let roundTrip = "";
    await act(async () => {
      roundTrip = await result.current.decryptContent(payload, "credential-ignored-for-keypair");
    });
    expect(roundTrip).toBe("rsa secret");
  }, CRYPTO_TIMEOUT);

  it("decryptContent rejects when no stored key pair matches the fingerprint", async () => {
    const { result } = renderHook(() => useEncryption());
    await act(async () => {
      await result.current.importJwk("Base", baseKp.publicKeyJwk, baseKp.privateKeyJwk);
    });

    let payload: EncryptedPayload | undefined;
    await act(async () => {
      payload = await result.current.encryptContent("rsa secret", "keypair", baseKp);
    });
    if (!payload) throw new Error("encryptContent returned no payload");

    const stray: EncryptedPayload = { ...payload, keyFingerprint: "NO-SUCH-FP" };
    await act(async () => {
      await expect(result.current.decryptContent(stray, "anything")).rejects.toThrow(
        "Key pair not found for fingerprint: NO-SUCH-FP"
      );
    });
  }, CRYPTO_TIMEOUT);

  it("exposes JWK/PEM export and a manual refresh", async () => {
    const { result } = renderHook(() => useEncryption());
    await waitFor(() => expect(result.current.keyPairs).toEqual([]));

    const jwks = await result.current.exportAsJwk(baseKp);
    expect(jwks).toEqual({ publicKey: baseKp.publicKeyJwk, privateKey: baseKp.privateKeyJwk });

    const exported = await result.current.exportAsPem(baseKp);
    expect(exported.publicPem).toBe(pems.publicPem);
    expect(exported.privatePem).toBe(pems.privatePem);

    await act(async () => {
      await result.current.refreshKeyPairs();
    });
    expect(result.current.keyPairs).toEqual([]);
  }, CRYPTO_TIMEOUT);
});