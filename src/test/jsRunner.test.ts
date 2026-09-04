import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSandboxedJSRunner, registerJSRunner } from '@/lib/jsRunner';
import { getRunner, hasRunner, listRunners, unregisterRunner } from '@/lib/codeRunners';

describe('sandboxed JS runner setTimeout policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks setTimeout with delay greater than 5s', async () => {
    const runner = createSandboxedJSRunner();
    const result = await runner(`
      setTimeout(() => { console.log("never fires"); }, 6000);
      console.log("still runs");
    `);
    expect(result).toContain('[blocked] setTimeout with delay > 5s');
    expect(result).toContain('[log]: still runs');
    expect(result).not.toContain('never fires');
  });

  it('runs setTimeout with delay up to 5s', async () => {
    vi.useFakeTimers();
    const runner = createSandboxedJSRunner();
    const pending = runner(`
      await new Promise((resolve) => setTimeout(resolve, 100));
      console.log("after timer");
    `);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toBe('[log]: after timer');
  });

  it('allows setTimeout at exactly 5s', async () => {
    vi.useFakeTimers();
    const runner = createSandboxedJSRunner();
    const pending = runner(`
      await new Promise((resolve) => setTimeout(resolve, 5000));
      console.log("boundary fired");
    `);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result).toBe('[log]: boundary fired');
  });
});

describe('sandboxed JS runner value formatting', () => {
  it('falls back to String() for circular objects passed to console.log', async () => {
    const runner = createSandboxedJSRunner();
    const result = await runner(`
      const a = {};
      a.self = a;
      console.log(a);
    `);
    expect(result).toBe('[log]: [object Object]');
  });

  it('falls back to String() for circular objects returned from the code', async () => {
    const runner = createSandboxedJSRunner();
    const result = await runner(`
      const a = {};
      a.self = a;
      return a;
    `);
    expect(result).toBe('[object Object]');
  });

  // Observed behavior: JSON.stringify throws on the circular reference, so the
  // String() fallback runs — but for a self-referential *array* String() itself
  // resolves to '' (V8's join cycle guard), so the runner outputs an empty
  // string instead of an error.
  it('falls back to String() for circular arrays returned from the code', async () => {
    const runner = createSandboxedJSRunner();
    const result = await runner(`
      const a = [];
      a.push(a);
      return a;
    `);
    expect(result).toBe('');
  });

  it('formats null and undefined values', async () => {
    const runner = createSandboxedJSRunner();
    const result = await runner('console.log(null); console.log(undefined);');
    expect(result).toBe('[log]: null\n[log]: undefined');
  });

  it('captures console.info output', async () => {
    const runner = createSandboxedJSRunner();
    const result = await runner('console.info("info message")');
    expect(result).toBe('[log] ℹ: info message');
  });

  it('rejects with the string form of a non-Error throw', async () => {
    const runner = createSandboxedJSRunner();
    await expect(runner('throw "boom";')).rejects.toThrow('boom');
  });
});

describe('registerJSRunner', () => {
  afterEach(() => {
    for (const lang of listRunners()) {
      unregisterRunner(lang);
    }
  });

  it('registers the runner under both javascript and js', () => {
    registerJSRunner();
    expect(hasRunner('javascript')).toBe(true);
    expect(hasRunner('js')).toBe(true);
    expect(getRunner('javascript')).toBe(getRunner('js'));
  });

  it('registered runner executes sandboxed code', async () => {
    registerJSRunner();
    const runner = getRunner('js');
    expect(runner).toBeDefined();
    const result = await runner?.('console.log("via registry")');
    expect(result).toBe('[log]: via registry');
  });

  it('registered runner still enforces the sandbox', async () => {
    registerJSRunner();
    const result = await getRunner('javascript')?.('fetch("http://example.com")');
    expect(result).toContain('[blocked] fetch()');
  });
});