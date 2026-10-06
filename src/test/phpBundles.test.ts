import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { PHP_VERSIONS } from '@/lib/phpRunner';

// PHP now follows the same vendor.json contract as the other languages (its
// only remaining gap is provenance: it has no builder, so no manifest.json).
// Every asset is checked against its recorded hash, and gzipped assets are
// decompressed first, so a corrupt bundle fails here rather than at Run.
const PUBLIC_DIR = join(process.cwd(), 'public', 'php-wasm');

describe('vendored PHP bundles', () => {
  for (const version of PHP_VERSIONS) {
    it(`${version} has a wasm module and loader`, () => {
      const dir = join(PUBLIC_DIR, `build-${version}`);
      expect(existsSync(dir), `missing ${dir}`).toBe(true);

      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      expect(existsSync(join(dir, vendor.loader)), `missing loader ${vendor.loader}`).toBe(true);

      for (const [name, meta] of Object.entries<{ sha256: string }>(vendor.files)) {
        const gzipped = vendor.gzip.includes(name);
        const file = join(dir, gzipped ? `${name}.gz` : name);
        expect(existsSync(file), `missing ${name}${gzipped ? '.gz' : ''}`).toBe(true);
        const raw = gzipped ? gunzipSync(readFileSync(file)) : readFileSync(file);
        expect(createHash('sha256').update(raw).digest('hex'), `${name} drifted`).toBe(meta.sha256);
      }

      // It must still be real WebAssembly, not an error page.
      const wasm = vendor.gzip.includes('php-web.wasm')
        ? gunzipSync(readFileSync(join(dir, 'php-web.wasm.gz')))
        : readFileSync(join(dir, 'php-web.wasm'));
      expect([...wasm.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    });
  }

  it('has no build-* directory the runner cannot reach', () => {
    const onDisk = readdirSync(PUBLIC_DIR)
      .filter((name) => name.startsWith('build-'))
      .map((name) => name.slice('build-'.length))
      .sort();
    expect(onDisk).toEqual([...PHP_VERSIONS].sort());
  });
});
