import { describe, it, expect } from 'vitest';
import {
  ELIXIR_BUNDLES,
  ELIXIR_VERSIONS,
  DEFAULT_ELIXIR_VERSION,
  checkElixirVersionAvailable,
  getAvailableElixirVersions,
  createElixirRunner,
} from '@/lib/elixirRunner';
import { getRunnerVersions, getRunnerAvailability } from '@/lib/codeRunners';

describe('Elixir runner bundle table', () => {
  it('exposes every vendored bundle with a unique version label', () => {
    expect(ELIXIR_BUNDLES.length).toBeGreaterThan(0);
    expect(new Set(ELIXIR_VERSIONS).size).toBe(ELIXIR_VERSIONS.length);
    expect(DEFAULT_ELIXIR_VERSION).toBe('1.20.4');
  });

  it('registers the runner with an availability probe', () => {
    expect(getRunnerVersions('elixir')).toEqual([...ELIXIR_VERSIONS]);
    expect(getRunnerAvailability('elixir')?.required).toEqual([DEFAULT_ELIXIR_VERSION]);
  });

  it('createElixirRunner returns a callable runner', () => {
    expect(createElixirRunner()).toBeTypeOf('function');
  });
});

describe('Elixir version availability', () => {
  it('reports a version as unavailable when its vendor.json 404s', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
    await expect(checkElixirVersionAvailable(DEFAULT_ELIXIR_VERSION)).resolves.toBe(false);
    globalThis.fetch = original;
  });

  it('is optimistic on network failure (keeps the version)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await expect(checkElixirVersionAvailable(DEFAULT_ELIXIR_VERSION)).resolves.toBe(true);
    globalThis.fetch = original;
  });

  it('getAvailableElixirVersions reports the present bundles', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
    expect(await getAvailableElixirVersions()).toEqual([...ELIXIR_VERSIONS]);
    globalThis.fetch = original;
  });
});
