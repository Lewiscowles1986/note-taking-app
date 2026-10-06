import { describe, it, expect } from 'vitest';
import '@/lib/registerRunners';
import { hasRunner, getRunnerAvailability } from '@/lib/codeRunners';

describe('runner auto-registration', () => {
  it('registers the built-in runners on import', () => {
    expect(hasRunner('javascript')).toBe(true);
    expect(hasRunner('js')).toBe(true);
    expect(hasRunner('php')).toBe(true);
  });

  it('registers the PHP availability probe', () => {
    expect(getRunnerAvailability('php')?.required).toEqual(['5.4.45', '7.4.33', '8.4.25']);
  });
});
