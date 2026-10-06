import { describe, it, expect } from 'vitest';
import {
  RUBY_BUNDLES,
  RUBY_VERSIONS,
  DEFAULT_RUBY_VERSION,
  checkRubyVersionAvailable,
  getAvailableRubyVersions,
  createRubyRunner,
} from '@/lib/rubyRunner';
import { getRunnerVersions, getRunnerAvailability } from '@/lib/codeRunners';

describe('Ruby runner bundle table', () => {
  it('exposes every vendored bundle with a unique version label', () => {
    expect(RUBY_BUNDLES.length).toBeGreaterThan(0);
    const labels = RUBY_VERSIONS;
    expect(new Set(labels).size, 'version labels must be unique').toBe(labels.length);
    expect(labels).toContain(DEFAULT_RUBY_VERSION);
    expect(RUBY_BUNDLES).toContainEqual({ version: '4.0.0', directory: '4.0' });
    expect(RUBY_BUNDLES).toContainEqual({ version: '1.8.7', directory: '1.8.7-p374' });
  });

  it('registers the runner with an availability probe', () => {
    expect(getRunnerVersions('ruby')).toEqual([...RUBY_VERSIONS]);
    expect(getRunnerAvailability('ruby')?.required).toEqual([DEFAULT_RUBY_VERSION]);
  });

  it('createRubyRunner returns a callable runner', () => {
    expect(createRubyRunner()).toBeTypeOf('function');
  });
});

describe('Ruby version availability', () => {
  it('is optimistic on network failure (keeps the version)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await expect(checkRubyVersionAvailable(DEFAULT_RUBY_VERSION)).resolves.toBe(true);
    globalThis.fetch = original;
  });

  it('reports a version as unavailable when its vendor.json 404s', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
    await expect(checkRubyVersionAvailable(DEFAULT_RUBY_VERSION)).resolves.toBe(false);
    globalThis.fetch = original;
  });

  it('getAvailableRubyVersions reports the present bundles', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
    const avail = await getAvailableRubyVersions();
    expect(avail).toEqual([...RUBY_VERSIONS]);
    globalThis.fetch = original;
  });
});
