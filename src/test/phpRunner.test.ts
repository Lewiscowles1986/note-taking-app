import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PHP_VERSIONS,
  DEFAULT_PHP_VERSION,
  REQUIRED_PHP_VERSIONS,
  checkPhpVersionAvailable,
  getAvailablePhpVersions,
  createPhpRunner,
  registerPhpRunner,
} from '@/lib/phpRunner';
import {
  unregisterRunner,
  getRunner,
  hasRunner,
  getRunnerVersions,
  getDefaultVersion,
  listRunners,
} from '@/lib/codeRunners';

describe('PHP runner registration', () => {
  beforeEach(() => {
    for (const lang of listRunners()) {
      unregisterRunner(lang);
    }
  });

  it('exposes the full set of PHP versions', () => {
    expect(PHP_VERSIONS).toEqual([
      '5.4.45',
      '5.5.38',
      '5.6.40',
      '7.0.33',
      '7.1.33',
      '7.2.34',
      '7.3.33',
      '7.4.33',
      '8.0.30',
      '8.1.33',
      '8.2.29',
      '8.3.23',
      '8.4.x',
      '8.5.x',
    ]);
    expect(DEFAULT_PHP_VERSION).toBe('8.4.x');
  });

  it('registers a versioned php runner', () => {
    registerPhpRunner();
    expect(hasRunner('php')).toBe(true);
    expect(getRunner('php')).toBeTypeOf('function');
    expect(getRunnerVersions('php')).toEqual([...PHP_VERSIONS]);
    expect(getDefaultVersion('php')).toBe(DEFAULT_PHP_VERSION);
  });

  it('createPhpRunner returns a callable runner', () => {
    const runner = createPhpRunner();
    expect(runner).toBeTypeOf('function');
  });
});

describe('PHP version availability', () => {
  it('declares the required versions (last of each major line)', () => {
    expect(REQUIRED_PHP_VERSIONS).toEqual(['5.6.40', '7.4.33', '8.4.x']);
  });

  it('checkPhpVersionAvailable returns true for a 200 HEAD', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await expect(checkPhpVersionAvailable('8.4.x')).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it('checkPhpVersionAvailable returns false for a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(checkPhpVersionAvailable('8.4.x')).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it('checkPhpVersionAvailable is optimistic on network failure (keeps the version)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(checkPhpVersionAvailable('8.4.x')).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it('getAvailablePhpVersions filters to the versions that respond 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({ ok: url.includes('8.4.x') || url.includes('7.4.33') }),
      ),
    );
    const avail = await getAvailablePhpVersions();
    expect(avail).toContain('8.4.x');
    expect(avail).toContain('7.4.33');
    expect(avail).not.toContain('5.4.45');
    expect(avail).not.toContain('8.5.x');
    vi.unstubAllGlobals();
  });
});
