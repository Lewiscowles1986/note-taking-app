import { describe, it, expect } from 'vitest';
import {
  parseSpec,
  parseSimpleYaml,
  parseSpecObject,
  SpecParseError,
  looksLikeJson,
} from '@/lib/swaggerSpec';

const JSON_SPEC = `{
  "openapi": "3.0.3",
  "info": { "title": "Pet Store", "version": "1.0.2" },
  "servers": [{ "url": "https://petstore.example.com/v1" }],
  "paths": {
    "/pets": {
      "get": {
        "tags": ["pets"],
        "summary": "List pets",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer" } }
        ],
        "responses": {
          "200": { "description": "A list of pets" },
          "404": { "description": "Not found" }
        }
      },
      "post": {
        "tags": ["pets"],
        "summary": "Create a pet",
        "requestBody": { "content": { "application/json": {} } },
        "responses": { "201": { "description": "Created" } }
      },
      "delete": {
        "deprecated": true,
        "summary": "Nuke all pets",
        "responses": { "204": { "description": "Gone" } }
      }
    }
  }
}`;

const YAML_SPEC = `openapi: 3.0.3
info:
  title: Pet Store # a comment
  version: "1.0.2"
servers:
  - url: https://petstore.example.com/v1
    description: Production
paths:
  /pets:
    get:
      tags: [pets, public]
      summary: List pets
      parameters:
        - name: limit
          in: query
          description: How many to return
          schema:
            type: integer
      responses:
        "200":
          description: |
            A list of pets
            maybe multiple lines
        "404": { description: Not found }
components:
  schemas:
    Pet:
      type: object
`;

describe('looksLikeJson', () => {
  it('detects JSON vs YAML', () => {
    expect(looksLikeJson('{"openapi": "3.0"}')).toBe(true);
    expect(looksLikeJson('\n  { }')).toBe(true);
    expect(looksLikeJson('openapi: 3.0')).toBe(false);
    expect(looksLikeJson('')).toBe(false);
  });
});

describe('parseSpec with JSON', () => {
  it('parses a full JSON spec', () => {
    const spec = parseSpec(JSON_SPEC);
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info?.title).toBe('Pet Store');
    expect(spec.servers?.[0].url).toBe('https://petstore.example.com/v1');
    expect(Object.keys(spec.paths!)).toEqual(['/pets']);
    expect(spec.paths!['/pets'].get?.summary).toBe('List pets');
    expect(spec.paths!['/pets'].delete?.deprecated).toBe(true);
  });
});

describe('parseSpec with YAML', () => {
  it('parses nested mappings, lists, flow styles and comments', () => {
    const spec = parseSpec(YAML_SPEC);
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info?.title).toBe('Pet Store');
    expect(spec.info?.version).toBe('1.0.2');
    expect(spec.servers).toEqual([
      { url: 'https://petstore.example.com/v1', description: 'Production' },
    ]);
    const get = spec.paths!['/pets'].get!;
    expect(get.tags).toEqual(['pets', 'public']);
    expect(get.parameters?.[0]).toEqual({
      name: 'limit',
      in: 'query',
      description: 'How many to return',
      schema: { type: 'integer' },
    });
    expect(get.responses!['200']?.description).toContain('maybe multiple lines');
    expect(get.responses!['404']?.description).toBe('Not found');
    expect(spec.components?.schemas?.Pet).toEqual({ type: 'object' });
  });

  it('parses scalars: numbers, booleans, null, quoted strings', () => {
    const parsed = parseSimpleYaml('a: 42\nb: -7\nc: 1.5\nd: true\ne: null\nf: ~\ng: "quoted: value"\nh: plain');
    expect(parsed).toEqual({
      a: 42,
      b: -7,
      c: 1.5,
      d: true,
      e: null,
      f: null,
      g: 'quoted: value',
      h: 'plain',
    });
  });

  it('handles empty flow collections', () => {
    const parsed = parseSimpleYaml('emptyList: []\nemptyMap: {}');
    expect(parsed.emptyList).toEqual([]);
    expect(parsed.emptyMap).toEqual({});
  });

  it('handles nested flow maps in lists', () => {
    const parsed = parseSimpleYaml('items:\n  - {a: 1, b: two}\n  - {a: 3, b: four}');
    expect(parsed.items).toEqual([
      { a: 1, b: 'two' },
      { a: 3, b: 'four' },
    ]);
  });

  it('handles folded block scalars', () => {
    const parsed = parseSimpleYaml('desc: >\n  first\n  second\nkey: value');
    expect(parsed.desc).toBe('first second');
    expect(parsed.key).toBe('value');
  });
});

describe('parseSpec validation', () => {
  it('rejects an empty spec', () => {
    expect(() => parseSpec('   ')).toThrow(SpecParseError);
    expect(() => parseSpec('   ')).toThrow(/Empty spec/);
  });

  it('rejects JSON with syntax errors', () => {
    expect(() => parseSpec('{"openapi": broken}')).toThrow(/Invalid JSON spec/);
  });

  it('rejects specs missing info', () => {
    expect(() => parseSpecObject({ paths: {} })).toThrow(/Missing required "info"/);
  });

  it('rejects specs missing paths', () => {
    expect(() => parseSpecObject({ info: { title: 'x' } })).toThrow(/Missing required "paths"/);
  });

  it('rejects non-object specs and malformed YAML', () => {
    expect(() => parseSpecObject([1, 2])).toThrow(/must be an object/);
    expect(() => parseSpec('- a\n- b')).toThrow(/must start with a mapping/);
  });

  it('rejects a top-level scalar YAML doc', () => {
    // A bare scalar line is not a mapping entry, so the line parser rejects it.
    expect(() => parseSpec('just a string')).toThrow(SpecParseError);
    expect(() => parseSpec('just a string')).toThrow(/Cannot parse YAML line/);
  });
});

describe('Swagger 2.0 specs', () => {
  it('parses swagger: "2.0" with definitions', () => {
    const spec = parseSpec(
      JSON.stringify({
        swagger: '2.0',
        info: { title: 'Legacy', version: '2.0' },
        paths: { '/x': { get: { responses: { 200: { description: 'ok' } } } } },
        definitions: { Pet: { type: 'object' } },
      })
    );
    expect(spec.swagger).toBe('2.0');
    expect(spec.definitions?.Pet).toEqual({ type: 'object' });
  });
});