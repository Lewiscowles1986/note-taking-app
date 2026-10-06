import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { RUBY_BUNDLES } from '@/lib/rubyRunner';

// Guards the version -> directory mapping, that every declared asset exists,
// and that gzipped assets decompress to the exact bytes the build produced.
// A selector version pointing at a missing or corrupted bundle would otherwise
// only show up as a silently missing Run button.
const PUBLIC_DIR = join(process.cwd(), 'public', 'ruby-wasm');

describe('vendored Ruby bundles', () => {
  for (const bundle of RUBY_BUNDLES) {
    it(`${bundle.version} (${bundle.directory}) is complete and intact`, () => {
      const dir = join(PUBLIC_DIR, `build-${bundle.directory}`);
      expect(existsSync(dir), `missing ${dir}`).toBe(true);

      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      expect(existsSync(join(dir, vendor.loader)), `missing loader ${vendor.loader}`).toBe(true);
      expect(['createVM', 'runCommand']).toContain(vendor.api);

      for (const [name, meta] of Object.entries<{ sha256: string }>(vendor.files)) {
        const gzipped = vendor.gzip.includes(name);
        const file = join(dir, gzipped ? `${name}.gz` : name);
        expect(existsSync(file), `missing ${name}${gzipped ? '.gz' : ''}`).toBe(true);
        const raw = gzipped ? gunzipSync(readFileSync(file)) : readFileSync(file);
        const digest = createHash('sha256').update(raw).digest('hex');
        expect(digest, `${name} drifted from the build manifest`).toBe(meta.sha256);
      }
    });
  }

  it('keeps the vendored set within the repo size budget', () => {
    let bytes = 0;
    for (const bundle of RUBY_BUNDLES) {
      const dir = join(PUBLIC_DIR, `build-${bundle.directory}`);
      const vendor = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
      for (const [name, meta] of Object.entries<{ bytes: number }>(vendor.files)) {
        const file = join(dir, vendor.gzip.includes(name) ? `${name}.gz` : name);
        bytes += existsSync(file) ? readFileSync(file).length : meta.bytes;
      }
    }
    expect(bytes).toBeLessThan(200 * 1024 * 1024);
  });
});
