import { describe, it, expect } from 'vitest';
import {
  PYTHON_BUNDLES,
  PYTHON_VERSIONS,
  DEFAULT_PYTHON_VERSION,
  checkPythonVersionAvailable,
  getAvailablePythonVersions,
  createPythonRunner,
} from '@/lib/pythonRunner';
import { getRunnerVersions, getRunnerAvailability } from '@/lib/codeRunners';

describe('Python runner bundle table', () => {
  it('exposes every vendored bundle with a unique version label', () => {
    expect(PYTHON_BUNDLES.length).toBe(17);
    expect(new Set(PYTHON_VERSIONS).size).toBe(PYTHON_VERSIONS.length);
    expect(PYTHON_VERSIONS[0]).toBe('2.7.18');
    expect(PYTHON_VERSIONS).toContain('3.15.0rc2');
    expect(DEFAULT_PYTHON_VERSION).toBe('3.14.7');
  });

  it('registers the runner with an availability probe', () => {
    expect(getRunnerVersions('python')).toEqual([...PYTHON_VERSIONS]);
    expect(getRunnerAvailability('python')?.required).toEqual([DEFAULT_PYTHON_VERSION]);
  });

  it('createPythonRunner returns a callable runner', () => {
    expect(createPythonRunner()).toBeTypeOf('function');
  });
});

describe('Python version availability', () => {
  it('reports a version as unavailable when its vendor.json 404s', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ ok: false })) as unknown as typeof fetch;
    await expect(checkPythonVersionAvailable(DEFAULT_PYTHON_VERSION)).resolves.toBe(false);
    globalThis.fetch = original;
  });

  it('is optimistic on network failure (keeps the version)', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await expect(checkPythonVersionAvailable(DEFAULT_PYTHON_VERSION)).resolves.toBe(true);
    globalThis.fetch = original;
  });

  it('getAvailablePythonVersions reports the present bundles', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
    expect(await getAvailablePythonVersions()).toEqual([...PYTHON_VERSIONS]);
    globalThis.fetch = original;
  });
});
