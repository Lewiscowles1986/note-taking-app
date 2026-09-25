// Keys: RS256 keypair generation/persistence, and the 0600 permission on the
// freshly-written keys.json (private PEM inside — must not be group/other
// readable). Uses a real temp dir so fs.statSync sees the real mode bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadOrCreateKeys } from '../keys.mjs';

test('freshly generated keys.json is written with mode 0600', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notehaven-keys-'));
  try {
    const keys = await loadOrCreateKeys(dir);
    assert.equal(keys.persisted, false);
    const st = statSync(path.join(dir, 'keys.json'));
    const mode = st.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    // Reload: persisted path returns the same kid (sanity, cheap).
    const reloaded = await loadOrCreateKeys(dir);
    assert.equal(reloaded.kid, keys.kid);
    assert.equal(reloaded.persisted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});