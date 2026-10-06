import { describe, it, expect } from 'vitest';
import '@/lib/registerRunners';
import { hasRunner, getRunnerVersions } from '@/lib/codeRunners';

describe('wasm runner auto-registration', () => {
  it('registers every *Runner.ts module in src/lib', () => {
    expect(hasRunner('javascript')).toBe(true);
    expect(hasRunner('js')).toBe(true);
    expect(hasRunner('php')).toBe(true);
  });

  it('keeps the versioned runner metadata the CodeBlock selector needs', () => {
    expect(getRunnerVersions('php')?.length).toBeGreaterThan(0);
  });
});
