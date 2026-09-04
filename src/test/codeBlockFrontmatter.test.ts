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

  it('parses an inline notes value', () => {
    const raw = `notes: Uses the legacy mapping API\n---\ncode`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.notes).toBe('Uses the legacy mapping API');
    expect(code).toBe('code');
  });

  it('appends continuation lines after an inline notes value', () => {
    const raw = `notes: First line\n  continued here\n---\ncode`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.notes).toBe('First line\ncontinued here');
    expect(code).toBe('code');
  });

  it('ignores list items that follow an unknown key', () => {
    const raw = `compatible:\n  - 2.7\ntitle: My snippet\n  - orphan item\n---\ncode`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta).toEqual({ compatible: ['2.7'] });
    expect(code).toBe('code');
  });

  it('stops notes continuation at an unknown key', () => {
    const raw = `notes: start\ntitle: My snippet\n  this is not notes\n---\ncode`;
    const { meta, code } = parseCodeFrontmatter(raw);
    expect(meta.notes).toBe('start');
    expect(code).toBe('code');
  });
});
