import { describe, it, expect } from 'vitest';
import { detectContentFeatures } from '@/lib/db';

describe('detectContentFeatures', () => {
  it('detects fenced code blocks', () => {
    const content = 'Hello\n```javascript\nconst x = 1;\n```\nworld';
    const features = detectContentFeatures(content);
    expect(features.hasCodeBlocks).toBe(true);
    expect(features.hasMermaid).toBe(false);
  });

  it('detects mermaid blocks', () => {
    const content = '```mermaid\ngraph TD\nA-->B\n```';
    const features = detectContentFeatures(content);
    expect(features.hasMermaid).toBe(true);
    expect(features.hasCodeBlocks).toBe(false);
  });

  it('detects both code and mermaid', () => {
    const content = '```php\n<?php\n```\n\n```mermaid\ngraph TD\n```';
    const features = detectContentFeatures(content);
    expect(features.hasCodeBlocks).toBe(true);
    expect(features.hasMermaid).toBe(true);
  });

  it('returns false for plain markdown', () => {
    const content = '# Hello\n\nSome text with `inline code`';
    const features = detectContentFeatures(content);
    expect(features.hasCodeBlocks).toBe(false);
    expect(features.hasMermaid).toBe(false);
  });

  it('does not count mermaid as a code block', () => {
    const content = '```mermaid\ngraph TD\nA-->B\n```';
    const features = detectContentFeatures(content);
    expect(features.hasCodeBlocks).toBe(false);
  });
});
