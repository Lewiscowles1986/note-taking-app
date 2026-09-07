import { describe, it, expect, beforeEach } from 'vitest';
import {
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
