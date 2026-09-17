import { describe, it, expect } from 'vitest';
import { looksLikeHtml } from '@/lib/htmlOutput';

describe('looksLikeHtml', () => {
  it('detects HTML output starting with a tag', () => {
    expect(looksLikeHtml('<h1>Hello</h1>')).toBe(true);
    expect(looksLikeHtml('<div>content</div>')).toBe(true);
    expect(looksLikeHtml('<p>text</p>')).toBe(true);
  });

  it('detects self-closing and void tags', () => {
    expect(looksLikeHtml('<br>')).toBe(true);
    expect(looksLikeHtml('<img src="x.png">')).toBe(true);
    expect(looksLikeHtml('<input type="text">')).toBe(true);
  });

  it('detects HTML with leading whitespace', () => {
    expect(looksLikeHtml('  <table><tr><td>a</td></tr></table>')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(looksLikeHtml('Hello world')).toBe(false);
    expect(looksLikeHtml('sum=5')).toBe(false);
    expect(looksLikeHtml('Array\n(\n    [0] => 1\n)')).toBe(false);
  });

  it('returns false for text that does not start with a tag', () => {
    expect(looksLikeHtml('some <b>bold</b> text')).toBe(false);
  });

  it('returns false for empty or whitespace-only strings', () => {
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml('   ')).toBe(false);
  });
});
