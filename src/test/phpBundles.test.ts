import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PHP_VERSIONS } from '@/lib/phpRunner';

// PHP predates the manifest + vendor.json contract the other languages use
// (see docs/wasm/README.md), so there are no recorded hashes to check it
// against. These assertions still catch the failure that matters — a bundle
// that is absent, truncated or not actually WebAssembly — and they pin the
// directory layout the runner resolves to.
const PUBLIC_DIR = join(process.cwd(), 'public', 'php-wasm');

describe('vendored PHP bundles', () => {
  for (const version of PHP_VERSIONS) {
    it(`${version} has a wasm module and loader`, () => {
      const dir = join(PUBLIC_DIR, `build-${version}`);
      expect(existsSync(dir), `missing ${dir}`).toBe(true);

      for (const name of ['php-web.mjs', 'php-web.wasm']) {
        const file = join(dir, name);
        expect(existsSync(file), `missing ${name}`).toBe(true);
        expect(statSync(file).size, `${name} looks truncated`).toBeGreaterThan(1024);
      }

      // The wasm magic number, so a stray HTML error page or gzip body fails here.
      const magic = readFileSync(join(dir, 'php-web.wasm')).subarray(0, 4);
      expect([...magic]).toEqual([0x00, 0x61, 0x73, 0x6d]);
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
