import { describe, it, expect } from 'vitest';
import '@/lib/registerRunners';
import { ENABLED_LANGUAGES } from '@/lib/languages';
import { hasRunner, getRunnerVersions } from '@/lib/codeRunners';

// The build activates exactly the languages VITE_LANGUAGES names: a disabled
// language must not register a runner, so its Run button and version list never
// appear. Run with VITE_LANGUAGES set to exercise a subset.
const enabled = (lang: string) => ENABLED_LANGUAGES.includes(lang);

describe('language enable list', () => {
  it('registers the JS plugin (and its javascript alias) only when enabled', () => {
    expect(hasRunner('js')).toBe(enabled('js'));
    expect(hasRunner('javascript')).toBe(enabled('js'));
  });

  it('registers PHP only when enabled, with its versions', () => {
    expect(hasRunner('php')).toBe(enabled('php'));
    expect(enabled('php') ? getRunnerVersions('php')?.length : 0).toBeTruthy();
  });

  it('registers Python only when enabled', () => {
    expect(hasRunner('python')).toBe(enabled('python'));
  });
});
