import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { PYTHON_BUNDLES } from '@/lib/pythonRunner';

// Guards the version -> directory mapping, that every declared asset exists,
// and that gzipped assets decompress to the exact bytes the build produced.
const PUBLIC_DIR = join(process.cwd(), 'public', 'python-wasm');

describe('vendored Python bundles', () => {
  for (const bundle of PYTHON_BUNDLES) {
    it(`${bundle.version} is complete and intact`, () => {
      const dir = join(PUBLIC_DIR, `build-${bundle.directory}`);
      expect(existsSync(dir), `missing ${dir}`).toBe(true);

      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      expect(existsSync(join(dir, vendor.loader))).toBe(true);

      for (const [name, meta] of Object.entries<{ sha256: string }>(vendor.files)) {
        const gzipped = vendor.gzip.includes(name);
        const file = join(dir, gzipped ? `${name}.gz` : name);
        expect(existsSync(file), `missing ${name}${gzipped ? '.gz' : ''}`).toBe(true);
        const raw = gzipped ? gunzipSync(readFileSync(file)) : readFileSync(file);
        expect(createHash('sha256').update(raw).digest('hex'), `${name} drifted`).toBe(meta.sha256);
      }
    });
  }
});
