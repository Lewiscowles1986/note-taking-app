import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ELIXIR_BUNDLES } from '@/lib/elixirRunner';

// Guards the version -> directory mapping and that every declared asset exists,
// including beam.emu.mjs, which the Emscripten pthread workers load by name —
// dropping it makes the VM abort with "worker sent an error".
const PUBLIC_DIR = join(process.cwd(), 'public', 'elixir-wasm');

describe('vendored Elixir bundles', () => {
  for (const bundle of ELIXIR_BUNDLES) {
    it(`${bundle.version} is complete and intact`, () => {
      const dir = join(PUBLIC_DIR, `build-${bundle.directory}`);
      expect(existsSync(dir), `missing ${dir}`).toBe(true);

      for (const required of ['beam.mjs', 'beam.emu.mjs', 'beam.wasm', 'filesystem.tar.gz', 'manifest.json']) {
        expect(existsSync(join(dir, required)), `missing ${required}`).toBe(true);
      }

      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      for (const [name, meta] of Object.entries<{ sha256: string }>(vendor.files)) {
        const gzipped = vendor.gzip.includes(name);
        const file = join(dir, gzipped ? `${name}.gz` : name);
        const raw = gzipped ? gunzipSync(readFileSync(file)) : readFileSync(file);
        expect(createHash('sha256').update(raw).digest('hex'), `${name} drifted`).toBe(meta.sha256);
      }
    });
  }
});
