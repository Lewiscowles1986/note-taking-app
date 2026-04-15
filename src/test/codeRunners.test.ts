import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRunner,
  unregisterRunner,
  getRunner,
  hasRunner,
  listRunners,
} from '@/lib/codeRunners';
import { createSandboxedJSRunner } from '@/lib/jsRunner';

describe('codeRunners registry', () => {
  beforeEach(() => {
    // Clean up between tests
    for (const lang of listRunners()) {
      unregisterRunner(lang);
    }
  });

  it('registers and retrieves a runner', () => {
    const runner = async (code: string) => code;
    registerRunner('python', runner);
    expect(hasRunner('python')).toBe(true);
    expect(getRunner('python')).toBe(runner);
  });

  it('is case-insensitive', () => {
    const runner = async (code: string) => code;
    registerRunner('Python', runner);
    expect(hasRunner('python')).toBe(true);
    expect(getRunner('PYTHON')).toBe(runner);
  });

  it('returns false for unregistered languages', () => {
    expect(hasRunner('rust')).toBe(false);
    expect(getRunner('rust')).toBeUndefined();
  });

  it('unregisters a runner', () => {
    registerRunner('go', async () => '');
    unregisterRunner('go');
    expect(hasRunner('go')).toBe(false);
  });

  it('lists registered runners', () => {
    registerRunner('js', async () => '');
    registerRunner('python', async () => '');
    expect(listRunners()).toEqual(expect.arrayContaining(['js', 'python']));
  });
});

describe('sandboxed JS runner', () => {
  const runner = createSandboxedJSRunner();

  it('captures console.log output', async () => {
    const result = await runner('console.log("hello world")');
    expect(result).toBe('[log]: hello world');
  });

  it('captures multiple console calls', async () => {
    const result = await runner('console.log("a"); console.log("b")');
    expect(result).toBe('[log]: a\n[log]: b');
  });

  it('returns expression result', async () => {
    const result = await runner('return 2 + 2');
    expect(result).toBe('4');
  });

  it('formats objects as JSON', async () => {
    const result = await runner('console.log({ x: 1 })');
    expect(result).toContain('"x": 1');
  });

  it('blocks alert', async () => {
    const result = await runner('alert("hi")');
    expect(result).toContain('[blocked] alert()');
  });

  it('blocks fetch', async () => {
    const result = await runner('fetch("http://example.com")');
    expect(result).toContain('[blocked] fetch()');
  });

  it('blocks eval', async () => {
    const result = await runner('eval("1+1")');
    expect(result).toContain('[blocked] eval()');
  });

  it('blocks window.open', async () => {
    const result = await runner('open("http://evil.com")');
    expect(result).toContain('[blocked] window.open()');
  });

  it('rejects on syntax errors', async () => {
    await expect(runner('const =')).rejects.toThrow();
  });

  it('rejects on runtime errors', async () => {
    await expect(runner('throw new Error("boom")')).rejects.toThrow('boom');
  });

  it('handles console.warn and console.error', async () => {
    const result = await runner('console.warn("w"); console.error("e")');
    expect(result).toContain('[log] ⚠: w');
    expect(result).toContain('[log] ✗: e');
  });

  it('supports basic math and data structures', async () => {
    const result = await runner(`
      const arr = [1, 2, 3];
      const sum = arr.reduce((a, b) => a + b, 0);
      console.log("sum:", sum);
    `);
    expect(result).toBe('[log]: sum: 6');
  });
});
