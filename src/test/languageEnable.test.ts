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

  for (const [lang, plugin] of [
    ['php', 'php'],
    ['python', 'python'],
    ['ruby', 'ruby'],
  ] as const) {
    it(`registers ${plugin} only when enabled`, () => {
      expect(hasRunner(lang)).toBe(enabled(plugin));
      if (enabled(plugin)) expect(getRunnerVersions(lang)?.length).toBeGreaterThan(0);
      else expect(getRunnerVersions(lang)).toBeUndefined();
    });
  }
});
