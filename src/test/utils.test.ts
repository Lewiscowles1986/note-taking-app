import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('joins plain class names', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('skips falsy conditional classes', () => {
    const hasError = (): boolean => false;
    expect(cn('base', hasError() && 'error-ring', undefined, null, '', 'end')).toBe('base end');
  });

  it('keeps only the active side of a ternary', () => {
    const isActive = false;
    expect(cn('btn', isActive ? 'btn-active' : '')).toBe('btn');
  });

  it('supports arrays and conditional objects', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });

  it('resolves conflicting tailwind classes keeping the last', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('resolves conflicts per variant', () => {
    expect(cn('hover:p-2', 'hover:p-4')).toBe('hover:p-4');
  });

  it('keeps non-conflicting classes from both inputs', () => {
    expect(cn('p-2', 'm-2', 'flex')).toBe('p-2 m-2 flex');
  });

  it('removes earlier conflicts inside a merged sequence', () => {
    expect(cn('px-2 py-1', 'px-10')).toBe('py-1 px-10');
  });

  it('deduplicates repeated classes', () => {
    expect(cn('flex', 'flex')).toBe('flex');
  });

  it('returns an empty string for no inputs', () => {
    expect(cn()).toBe('');
  });
});