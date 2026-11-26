import { describe, it, expect, beforeEach } from 'vitest';
import {
  PHP_BUNDLES,
  PHP_VERSIONS,
  DEFAULT_PHP_VERSION,
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
import manifest from '@/lib/phpWasm.manifest.json';

// The runner's version list is the compiled-in manifest rather than a
// hand-maintained array or a runtime probe, so these assert the wiring between
// the two and the invariants scripts/sync-php-wasm.mjs guarantees.
describe('PHP runner registration', () => {
  beforeEach(() => {
    for (const lang of listRunners()) {
      unregisterRunner(lang);
    }
  });

  it('exposes the compiled-in manifest verbatim', () => {
    expect(PHP_BUNDLES).toEqual(manifest.bundles);
    expect(PHP_VERSIONS).toEqual(manifest.bundles.map((b) => b.version));
    expect(DEFAULT_PHP_VERSION).toBe(manifest.default);
  });

  it('lists bundles oldest first and defaults to the newest', () => {
    const versions = PHP_BUNDLES.map((b) => b.version);
    const numeric = (v: string) => v.split('.').map(Number);
    const sorted = [...versions].sort((a, b) => {
      const [x, y] = [numeric(a), numeric(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return 0;
    });
    expect(versions).toEqual(sorted);
    expect(DEFAULT_PHP_VERSION).toBe(versions[versions.length - 1]);
  });

  it('maps every version to the series directory the sync script writes', () => {
    for (const bundle of PHP_BUNDLES) {
      const [major, minor] = bundle.version.split('.');
      expect(bundle.directory).toBe(`build-${major}.${minor}.x`);
    }
  });

  it('keeps the legacy 5.4 and 7.4 bundles the builder cannot rebuild', () => {
    expect(PHP_VERSIONS).toContain('5.4.45');
    expect(PHP_VERSIONS).toContain('7.4.33');
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
