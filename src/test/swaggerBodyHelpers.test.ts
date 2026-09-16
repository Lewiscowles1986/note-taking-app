import { describe, it, expect } from 'vitest';
import {
  sampleFromSchema,
  defaultRequestBody,
  mediaTypeLabel,
  scaffoldFor,
} from '@/lib/swaggerSpec';

describe('sampleFromSchema', () => {
  it('prefers an explicit example', () => {
    expect(sampleFromSchema({ type: 'string', example: 'Rex' })).toBe('Rex');
  });

  it('uses the first enum value', () => {
    expect(sampleFromSchema({ type: 'string', enum: ['small', 'large'] })).toBe('small');
  });

  it('generates required-first object properties', () => {
    const sample = sampleFromSchema({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        nickname: { type: 'string' },
      },
    });
    expect(sample).toEqual({ name: 'string', age: 1, tags: ['string'], nickname: 'string' });
  });

  it('caps nesting depth and handles primitives/formats', () => {
    expect(sampleFromSchema({ type: 'boolean' })).toBe(true);
    expect(sampleFromSchema({ type: 'string', format: 'date-time' })).toBe('2026-01-01T00:00:00Z');
    expect(sampleFromSchema({ type: 'string', format: 'date' })).toBe('2026-01-01');
    expect(sampleFromSchema({ type: 'integer', format: 'int64' })).toBe(9007199254740991);
    expect(sampleFromSchema({ $ref: '#/components/schemas/Pet' })).toEqual({ '<Pet>': null });
    expect(sampleFromSchema(null)).toBeNull();
    expect(sampleFromSchema({ type: 'object', properties: { deep: { type: 'object', properties: { deeper: { type: 'object', properties: { deepest: { type: 'object' } } } } } } })).toBeDefined();
  });
});

describe('defaultRequestBody', () => {
  const content = {
    'application/json': {
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    },
  };

  it('uses the schema example when present', () => {
    expect(
      defaultRequestBody('application/json', {
        'application/json': { schema: { type: 'object' }, example: { id: 7 } },
      })
    ).toBe('{\n  "id": 7\n}');
  });

  it('falls back to a sample generated from the schema', () => {
    expect(defaultRequestBody('application/json', content)).toBe('{\n  "name": "string"\n}');
  });

  it('scaffolds when there is no schema or example', () => {
    expect(defaultRequestBody('application/json', {})).toBe('{\n  \n}');
    expect(defaultRequestBody('application/x-www-form-urlencoded')).toBe('key=value');
    expect(defaultRequestBody('text/plain')).toBe('');
  });
});

describe('mediaTypeLabel', () => {
  it('labels common media types', () => {
    expect(mediaTypeLabel('application/json')).toBe('JSON');
    expect(mediaTypeLabel('application/ld+json')).toBe('JSON');
    expect(mediaTypeLabel('text/plain')).toBe('Text');
    expect(mediaTypeLabel('application/xml')).toBe('XML');
    expect(mediaTypeLabel('application/x-www-form-urlencoded')).toBe('Form');
    expect(mediaTypeLabel('application/octet-stream')).toBe('application/octet-stream');
  });
});

describe('scaffoldFor', () => {
  it('returns empty string for unknown types', () => {
    expect(scaffoldFor('application/weird')).toBe('');
  });
});