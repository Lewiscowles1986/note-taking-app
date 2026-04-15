import { useState, useEffect, useCallback } from 'react';
import type { Note } from '@/lib/db';
import type { StoredKeyPair, EncryptedPayload } from '@/lib/crypto';
import {
  encryptWithPassword,
  decryptWithPassword,
  encryptWithPublicKey,
  decryptWithPrivateKey,
  generateKeyPair as cryptoGenerateKeyPair,
  importPemKeyPair,
  importJwkKeyPair,
  exportKeyPairAsJwk,
  exportKeyPairAsPem,
} from '@/lib/crypto';
import {
  saveKeyPair,
  getAllKeyPairs,
  deleteKeyPair as dbDeleteKeyPair,
  getKeyPairByFingerprint,
} from '@/lib/db';

export function useEncryption() {
  const [keyPairs, setKeyPairs] = useState<StoredKeyPair[]>([]);

  const refresh = useCallback(async () => {
    setKeyPairs(await getAllKeyPairs());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const generateNewKeyPair = useCallback(async (name: string) => {
    const kp = await cryptoGenerateKeyPair(name);
    await saveKeyPair(kp);
    await refresh();
    return kp;
  }, [refresh]);

  const importPem = useCallback(async (name: string, pubPem: string, privPem: string) => {
    const kp = await importPemKeyPair(name, pubPem, privPem);
    await saveKeyPair(kp);
    await refresh();
    return kp;
  }, [refresh]);

  const importJwk = useCallback(async (name: string, pubJwk: JsonWebKey, privJwk: JsonWebKey) => {
    const kp = await importJwkKeyPair(name, pubJwk, privJwk);
    await saveKeyPair(kp);
    await refresh();
    return kp;
  }, [refresh]);

  const removeKeyPair = useCallback(async (id: string) => {
    await dbDeleteKeyPair(id);
    await refresh();
  }, [refresh]);

  const encryptContent = useCallback(async (
    content: string,
    method: 'password' | 'keypair',
    credential: string | StoredKeyPair,
  ): Promise<EncryptedPayload> => {
    if (method === 'password') {
      return encryptWithPassword(content, credential as string);
    } else {
      const kp = credential as StoredKeyPair;
      return encryptWithPublicKey(content, kp.publicKeyJwk);
    }
  }, []);

  const decryptContent = useCallback(async (
    payload: EncryptedPayload,
    credential: string,
  ): Promise<string> => {
    if (payload.method === 'password') {
      return decryptWithPassword(payload, credential);
    } else {
      // Find key pair by fingerprint
      const kp = await getKeyPairByFingerprint(payload.keyFingerprint!);
      if (!kp) throw new Error('Key pair not found for fingerprint: ' + payload.keyFingerprint);
      return decryptWithPrivateKey(payload, kp.privateKeyJwk);
    }
  }, []);

  return {
    keyPairs,
    generateNewKeyPair,
    importPem,
    importJwk,
    removeKeyPair,
    encryptContent,
    decryptContent,
    exportAsJwk: exportKeyPairAsJwk,
    exportAsPem: exportKeyPairAsPem,
    refreshKeyPairs: refresh,
  };
}
