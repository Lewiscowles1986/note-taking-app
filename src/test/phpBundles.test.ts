import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { PHP_BUNDLES } from '@/lib/phpRunner';
import manifest from '@/lib/phpWasm.manifest.json';

// The manifest is the runtime's entire view of what is supported, so it must
// agree with the directory tree: every bundle it lists is intact (hashes, real
// WebAssembly), and no build-* directory exists that it does not list.
const PUBLIC_DIR = join(process.cwd(), 'public', 'php-wasm');

describe('vendored PHP bundles', () => {
  for (const bundle of PHP_BUNDLES) {
    it(`${bundle.version} (${bundle.directory}) is complete and intact`, () => {
      const dir = join(PUBLIC_DIR, bundle.directory);
      expect(existsSync(dir), `missing ${dir}`).toBe(true);

      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      expect(vendor.version, 'vendor.json version drifted from the manifest').toBe(bundle.version);
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

    it(`${bundle.version} reports the version the build was compiled with`, () => {
      const dir = join(PUBLIC_DIR, bundle.directory);
      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      const wasm = vendor.gzip.includes('php-web.wasm')
        ? gunzipSync(readFileSync(join(dir, 'php-web.wasm.gz')))
        : readFileSync(join(dir, 'php-web.wasm'));
      const marker = /X-Powered-By: PHP\/(\d+\.\d+\.\d+)/.exec(wasm.toString('latin1'));
      expect(marker?.[1], 'no PHP version marker in the wasm').toBe(bundle.version);
    });
  }

  it('has no build-* directory the manifest cannot reach', () => {
    const onDisk = readdirSync(PUBLIC_DIR)
      .filter((name) => name.startsWith('build-'))
      .sort();
    expect(onDisk).toEqual(PHP_BUNDLES.map((b) => b.directory).sort());
  });

  it('lists the manifest default among its bundles', () => {
    expect(PHP_BUNDLES.map((b) => b.version)).toContain(manifest.default);
  });
});
