import { describe, it, expect } from 'vitest';
import {
  parseSpec,
  parseSimpleYaml,
  parseScalar,
  sampleFromSchema,
  defaultRequestBody,
  requestBodyExamples,
  SpecParseError,
} from '@/lib/swaggerSpec';
import {
  parseSwaggerFrontmatter,
  normalizeServerUrl,
  hostToServerUrl,
} from '@/lib/swaggerFrontmatter';

/**
 * Mutation-killing tests. Each test targets survivors found by Stryker
 * (reports/mutation/mutation.json) — branch conditions, regex boundaries,
 * string-literal defaults, and operator mutations that branch coverage
 * alone doesn't exercise.
 */
describe('mutation kills: YAML comment stripping', () => {
  it('strips a comment only when # is preceded by whitespace or starts the line', () => {
    // '# c' at start → comment
    expect(parseSimpleYaml('a: 1 # yes')).toEqual({ a: 1 });
    // '#tag' glued to a value is NOT a comment (needs whitespace before #)
    expect(parseSimpleYaml('a: value#tag')).toEqual({ a: 'value#tag' });
    // # inside quotes is not a comment
    expect(parseSimpleYaml('a: "# not a comment"')).toEqual({ a: '# not a comment' });
    expect(parseSimpleYaml("a: '# also not'")).toEqual({ a: '# also not' });
    // '#' inside single quotes while double quotes are open (state machine)
    expect(parseSimpleYaml('a: "x # y"')).toEqual({ a: 'x # y' });
    // a comment on its own line is dropped entirely
    expect(parseSimpleYaml('# whole line\na: 2')).toEqual({ a: 2 });
  });

  it('tracks quote state across the line (a lone quote hides a later #)', () => {
    // single-quote opens, # inside is literal, still open at EOL → line kept
    expect(parseSimpleYaml("a: it's # not a comment")).toEqual({ a: "it's # not a comment" });
  });
});

describe('mutation kills: scalar parsing corners', () => {
  it('distinguishes float vs int vs non-numeric strings', () => {
    const parsed = parseSimpleYaml('a: 1.5\nb: .5\nc: 1.\nd: 007\ne: -0.25');
    expect(parsed.a).toBe(1.5);
    expect(parsed.b).toBe(0.5); // leading-dot floats parse (regex -?\d*\.\d+)
    expect(parsed.c).toBe('1.'); // trailing dot is not a number
    expect(parsed.d).toBe(7); // leading zeros still parse as int
    expect(parsed.e).toBe(-0.25);
  });

  it('accepts all six case variants as booleans; mixed case stays string', () => {
    const parsed = parseSimpleYaml('a: true\nb: TRUE\nc: True\nd: tRuE');
    expect(parsed.a).toBe(true);
    expect(parsed.b).toBe(true);
    expect(parsed.c).toBe(true); // true/True/TRUE all accepted
    expect(parsed.d).toBe('tRuE'); // mixed case is NOT a boolean
    const f = parseSimpleYaml('a: false\nb: FALSE\nc: False\nd: fAlSe');
    expect(f.a).toBe(false);
    expect(f.b).toBe(false);
    expect(f.c).toBe(false); // false/False/FALSE all accepted
    expect(f.d).toBe('fAlSe');
  });

  it('treats Null/NULL/~ as null but not nullish strings', () => {
    const parsed = parseSimpleYaml('a: null\nb: Null\nc: NULL\nd: ~\ne: nULL\nf: "null"');
    expect(parsed.a).toBeNull();
    expect(parsed.b).toBeNull();
    expect(parsed.c).toBeNull();
    expect(parsed.d).toBeNull();
    expect(parsed.e).toBe('nULL');
    expect(parsed.f).toBe('null');
  });

  it('handles unclosed quotes as plain strings', () => {
    const parsed = parseSimpleYaml('a: "unclosed\nb: \'also');
    expect(parsed.a).toBe('"unclosed');
    expect(parsed.b).toBe("'also");
  });
});

describe('mutation kills: flow collections', () => {
  it('requires both opening and closing brackets', () => {
    // Unterminated flow list is treated as a scalar string
    expect(parseSimpleYaml('a: [1, 2')).toEqual({ a: '[1, 2' });
    expect(parseSimpleYaml('a: {b: 1')).toEqual({ a: '{b: 1' });
  });

  it('handles nested flow structures with quotes containing delimiters', () => {
    const parsed = parseSimpleYaml('a: ["x,y", {b: "c:d"}, 3]');
    expect(parsed.a).toEqual(['x,y', { b: 'c:d' }, 3]);
  });

  it('splits flow map entries on commas not inside quotes/brackets', () => {
    const parsed2 = parseSimpleYaml('m: {p: "q,r", s: [1,2]}');
    expect(parsed2).toEqual({ m: { p: 'q,r', s: [1, 2] } });
  });

  it('parses empty-ish flow values as empty containers', () => {
    expect(parseSimpleYaml('a: []')).toEqual({ a: [] });
    expect(parseSimpleYaml('b: {}')).toEqual({ b: {} });
  });
});

describe('mutation kills: splitKey corners', () => {
  it('requires a colon and trims the key; quoted keys are unquoted', () => {
    expect(parseSimpleYaml('"quoted key": v')).toEqual({ 'quoted key': 'v' });
    expect(parseSimpleYaml("'sq key': v")).toEqual({ 'sq key': 'v' });
    expect(parseSimpleYaml('key.with.dots: v')).toEqual({ 'key.with.dots': 'v' });
    expect(parseSimpleYaml('key-with-dashes: v')).toEqual({ 'key-with-dashes': 'v' });
    // URL-like keys (used by real specs)
    expect(parseSimpleYaml('application/json: {}')).toEqual({ 'application/json': {} });
  });

  it('keys without a colon are rejected', () => {
    expect(() => parseSimpleYaml('no colon here')).toThrow(SpecParseError);
  });
});

describe('mutation kills: block scalars', () => {
  it('| keeps newlines, > folds them', () => {
    const parsed = parseSimpleYaml('a: |\n  one\n  two\nb: >\n  three\n  four');
    expect(parsed.a).toBe('one\ntwo');
    expect(parsed.b).toBe('three four');
  });

  it('block scalar markers with chomping indicators are accepted', () => {
    const parsed = parseSimpleYaml('a: |-\n  kept\nb: >-\n  folded');
    expect(parsed.a).toBe('kept');
    expect(parsed.b).toBe('folded');
  });

  it('a block scalar with no body is an empty string', () => {
    const parsed = parseSimpleYaml('a: |\nb: 1');
    expect(parsed.a).toBe('');
    expect(parsed.b).toBe(1);
  });

  it('block scalar content deeper than the key indents correctly', () => {
    // 'yes' is NOT a boolean in this YAML 1.2-style parser — it stays a string
    const parsed = parseSimpleYaml('top:\n  desc: |\n    line one\n    line two\n  after: yes');
    expect(parsed.top).toEqual({ desc: 'line one\nline two', after: 'yes' });
  });
});

describe('mutation kills: sampleFromSchema', () => {
  it('caps object properties at 8', () => {
    const props: Record<string, unknown> = {};
    for (let i = 1; i <= 12; i++) props[`f${i}`] = { type: 'string' };
    const sample = sampleFromSchema({ type: 'object', properties: props }) as Record<string, unknown>;
    expect(Object.keys(sample)).toHaveLength(8);
    expect(sample).toHaveProperty('f8');
    expect(sample).not.toHaveProperty('f9');
  });

  it('prefers required properties over optional ones when truncating', () => {
    const sample = sampleFromSchema({
      type: 'object',
      required: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'],
      properties: {
        r1: { type: 'string' }, r9: { type: 'string' },
        o1: { type: 'string' }, o2: { type: 'string' },
        r2: { type: 'string' }, r3: { type: 'string' }, r4: { type: 'string' },
        r5: { type: 'string' }, r6: { type: 'string' }, r7: { type: 'string' },
      },
    }) as Record<string, unknown>;
    // required-first ordering means r1..r8 win over o1/o2
    expect(Object.keys(sample)).toEqual(['r1', 'r9', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  });

  it('handles arrays of objects and empty properties', () => {
    expect(sampleFromSchema({ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } }))
      .toEqual([{ id: 1 }]);
    expect(sampleFromSchema({ type: 'object' })).toEqual({});
    expect(sampleFromSchema({ type: 'object', properties: {} })).toEqual({});
  });

  it('number without int64 format returns 1', () => {
    expect(sampleFromSchema({ type: 'number' })).toBe(1);
    expect(sampleFromSchema({ type: 'number', format: 'float' })).toBe(1);
 expect(sampleFromSchema({ type: 'integer', format: 'int32' })).toBe(1);
  });

  it('uses declared default over generated value via example passthrough', () => {
    expect(sampleFromSchema({ type: 'string', example: 'pick-me' })).toBe('pick-me');
  });
});

describe('mutation kills: requestBodyExamples dedup and guards', () => {
  it('does not list the same value twice across example sources', () => {
    const content = {
      'application/json': {
        example: { name: 'same' },
        schema: { type: 'object', example: { name: 'same' } },
        examples: { dup: { summary: 'Dup', value: { name: 'same' } } },
      },
    };
    const examples = requestBodyExamples('application/json', content);
    const values = examples.map((e) => e.value);
    expect(new Set(values).size).toBe(values.length);
    // example and schema-sample dedupe against the named example's value
    expect(examples.map((e) => e.name)).toEqual(['Dup', 'Empty']);
  });

  it('skips malformed examples entries lacking a value field', () => {
    const content = {
      'application/json': {
        examples: { noValue: { summary: 'no value here' } as never },
        schema: { type: 'string' },
      },
    };
    const examples = requestBodyExamples('application/json', content);
    expect(examples.map((e) => e.name)).toEqual(['Schema sample', 'Empty']);
  });

  it('always appends Empty with the media-type-appropriate scaffold', () => {
    const examples = requestBodyExamples('text/plain', {});
    expect(examples).toEqual([{ name: 'Empty', value: '' }]);
    const jsonExamples = requestBodyExamples('application/json', {});
    expect(jsonExamples[jsonExamples.length - 1].value).toBe('{\n  \n}');
  });

  it('mediaTypeLabel covers every label branch', async () => {
    const { mediaTypeLabel } = await import('@/lib/swaggerSpec');
    expect(mediaTypeLabel('application/vnd.api+json')).toBe('JSON');
    expect(mediaTypeLabel('text/html')).toBe('Text');
    expect(mediaTypeLabel('multipart/form-data')).toBe('multipart/form-data');
  });
});

describe('mutation kills: frontmatter corners', () => {
  it('normalizeServerUrl requires scheme:// and trims trailing slashes', () => {
    expect(normalizeServerUrl('ftp://files.dev')).toBe('ftp://files.dev');
    expect(normalizeServerUrl('https://x.dev/')).toBe('https://x.dev');
    expect(normalizeServerUrl('//no-scheme.dev')).toBeNull();
    expect(normalizeServerUrl(':/missing')).toBeNull();
    expect(normalizeServerUrl('https://')).toBeNull();
  });

  it('host without scheme gets http://; host with path keeps it', () => {
    expect(hostToServerUrl({ host: 'plain.dev' })).toBe('http://plain.dev');
    expect(hostToServerUrl({ host: 'https://secure.dev/path' })).toBe('https://secure.dev/path');
    expect(hostToServerUrl({ host: '   ' })).toBeNull();
  });

  it('an opening --- with keys but no closing marker yields empty meta and spec body', () => {
    const { meta, specText } = parseSwaggerFrontmatter('---\nservers: https://x.dev\nspec: body');
    expect(meta).toEqual({});
    // everything after the opening marker becomes the spec (stray marker)
    expect(specText).toContain('servers: https://x.dev');
  });

  it('closing --- must not be the opening line itself', () => {
    // A single --- then content: closing search starts AFTER index 0
    const { specText } = parseSwaggerFrontmatter('---\nkey: value\n---\nrest');
    expect(specText).toBe('rest');
  });

  it('servers list items require the current key to be servers', () => {
    const { meta } = parseSwaggerFrontmatter('notes: hi\n  - https://orphan.dev\n---\nbody');
    // '- item' under notes is a continuation, not a server
    expect(meta.servers).toBeUndefined();
    expect(meta.notes).toBe('hi\n- https://orphan.dev');
  });

  it('list items only parse when a servers key is active', () => {
    const { meta } = parseSwaggerFrontmatter('host: api.dev\n  - https://not-a-server.dev\n---\nbody');
    // continuation lines under a non-list key are ignored
    expect(meta.host).toBe('api.dev');
    expect(meta.servers).toBeUndefined();
  });

  it('notes continuation lines keep their inner indentation trimmed on the left only', () => {
    const { meta } = parseSwaggerFrontmatter('notes:\n  line one\n    deeper indent\n---\nbody');
    expect(meta.notes).toBe('line one\ndeeper indent');
  });

  it('header lines require word-char keys', () => {
    const { meta } = parseSwaggerFrontmatter('not a key: ignored\nservers: https://x.dev\n---\nbody');
    // 'not a key: value' does not match ^(\w+): → ignored
    expect(meta.servers).toEqual(['https://x.dev']);
  });
});

describe('mutation kills: parse validation guards', () => {
  it('rejects null/object-primitive specs distinctly', () => {
    expect(() => parseSpec('null')).toThrow(SpecParseError);
    // a bare scalar line (no key:) is unparseable as a mapping
    expect(() => parseSpec('just a string')).toThrow(/Cannot parse YAML line/);
  });

  it('array items with mapping keys parse inline values then absorb nested lines', () => {
    const parsed = parseSimpleYaml('servers:\n  - url: https://a.dev\n    description: first\n  - url: https://b.dev');
    expect(parsed.servers).toEqual([
      { url: 'https://a.dev', description: 'first' },
      { url: 'https://b.dev' },
    ]);
  });

  it('an empty YAML document yields an empty spec error', () => {
    expect(() => parseSpec('')).toThrow(/Empty spec/);
  });

  it('deeply indented orphan lines attach to their nearest mapping', () => {
    const parsed = parseSimpleYaml('a:\n  b:\n    c: deep');
    expect(parsed).toEqual({ a: { b: { c: 'deep' } } });
  });
});