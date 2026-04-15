import { describe, it, expect } from 'vitest';
import { parseCodeFrontmatter } from '@/lib/codeBlockFrontmatter';

describe('parseCodeFrontmatter', () => {
  it('returns raw code when no frontmatter present', () => {
    const raw = 'print("hello")';
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(code).toBe(raw);
    expect(meta).toEqual({});
  });

  it('parses compatible and incompatible lists', () => {
    const raw = `compatible:\n  - 2.7\n  - 3.6\nincompatible:\n  - 3.10\n---\nprint("hi")`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.compatible).toEqual(['2.7', '3.6']);
    expect(meta.incompatible).toEqual(['3.10']);
    expect(code).toBe('print("hi")');
  });

  it('parses inline list syntax', () => {
    const raw = `compatible: 2.7, 3.6\n---\ncode here`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.compatible).toEqual(['2.7', '3.6']);
    expect(code).toBe('code here');
  });

  it('parses multi-line notes', () => {
    const raw = `notes:\n  This uses legacy APIs\n  Deprecated in 3.10\n---\ncode`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.notes).toBe('This uses legacy APIs\nDeprecated in 3.10');
    expect(code).toBe('code');
  });

  it('handles all fields together', () => {
    const raw = `compatible:\n  - 3.6\nincompatible:\n  - 3.10\nnotes:\n  Legacy mapping API\n---\nfrom collections import Mapping`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.compatible).toEqual(['3.6']);
    expect(meta.incompatible).toEqual(['3.10']);
    expect(meta.notes).toBe('Legacy mapping API');
    expect(code).toBe('from collections import Mapping');
  });
});
