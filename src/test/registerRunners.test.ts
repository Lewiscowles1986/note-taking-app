import { describe, it, expect } from 'vitest';
import '@/lib/registerRunners';
import { hasRunner, getRunnerVersions } from '@/lib/codeRunners';
import { DEFAULT_PHP_VERSION } from '@/lib/phpRunner';

describe('runner auto-registration', () => {
  it('registers the built-in runners on import', () => {
    expect(hasRunner('javascript')).toBe(true);
    expect(hasRunner('js')).toBe(true);
    expect(hasRunner('php')).toBe(true);
  });

  it('offers the vendored PHP versions without probing the network', () => {
    const versions = getRunnerVersions('php');
    expect(versions?.length).toBeGreaterThan(0);
    expect(versions).toContain(DEFAULT_PHP_VERSION);
  });
});
