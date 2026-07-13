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

  it('detects geojson blocks', () => {
    const content = '```geojson\n{ "type": "Point" }\n```';
    const features = detectContentFeatures(content);
    expect(features.hasGeoJson).toBe(true);
    expect(features.hasCodeBlocks).toBe(false);
    expect(features.hasMermaid).toBe(false);
  });

  it('does not count geojson as a code block', () => {
    const content = '```geojson\n{ "type": "Point" }\n```';
    const features = detectContentFeatures(content);
    expect(features.hasCodeBlocks).toBe(false);
  });

  it('detects mix of code, mermaid and geojson', () => {
    const content = '```python\nprint(1)\n```\n\n```mermaid\ngraph TD\n```\n\n```geojson\n{"type": "Feature"}\n```';
    const features = detectContentFeatures(content);
    expect(features.hasCodeBlocks).toBe(true);
    expect(features.hasMermaid).toBe(true);
    expect(features.hasGeoJson).toBe(true);
  });

  it('detects 3dmodel blocks', () => {
    const content = '```3dmodel\nattachment:clip.stl\n```';
    const features = detectContentFeatures(content);
    expect(features.hasModel3D).toBe(true);
    expect(features.hasCodeBlocks).toBe(false);
  });

  it('detects inline stl and obj attachments', () => {
    const contentStl = 'Here is the clip: ![clip](attachment:uuid.stl)';
    const contentObj = 'Here is the model: ![model](attachment:uuid.obj)';
    expect(detectContentFeatures(contentStl).hasModel3D).toBe(true);
    expect(detectContentFeatures(contentObj).hasModel3D).toBe(true);
  });
});
