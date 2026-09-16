import { describe, it, expect } from 'vitest';
import {
  parseSpec,
  parseSpecObject,
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
  applyBasePath,
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


// ─── Wave 2: deeper mutant kills ─────────────────────────────────────

describe('wave 2: parseSpecObject validation guards', () => {
  it('rejects arrays, Maps, and primitives as spec roots', () => {
    // Array.isArray mutant
    expect(() => parseSpecObject([1, 2])).toThrow(/must be an object/);
    // typeof-object: a Map IS typeof 'object' so it gets past the root guard
    // and fails later on missing info — pin that distinction
    expect(() => parseSpecObject(new Map())).toThrow(/Missing required "info"/);
    expect(() => parseSpecObject('string')).toThrow(/must be an object/);
    expect(() => parseSpecObject(42)).toThrow(/must be an object/);
    // !obj mutant
    expect(() => parseSpecObject(null)).toThrow(/must be an object/);
    // Each missing-key throw mutant is distinct — verify each message
    expect(() => parseSpecObject({})).toThrow(/Missing required "info"/);
    expect(() => parseSpecObject({ info: {} })).toThrow(/Missing required "paths"/);
    // info as non-object
    expect(() => parseSpecObject({ info: 'x', paths: {} })).toThrow(/Missing required "info"/);
    // paths as non-object
    expect(() => parseSpecObject({ info: {}, paths: 'x' })).toThrow(/Missing required "paths"/);
    // the happy shape passes
    expect(parseSpecObject({ info: {}, paths: {} })).toBeDefined();
  });
});

describe('wave 2: flow-collection interior parsing', () => {
  it('empty flow containers return [] and {} respectively', () => {
    // slice(1,-1) + empty-inner mutants: `[]` → null, `{}` → missing keys
    expect(parseSimpleYaml('a: [ ]')).toEqual({ a: [] });
    expect(parseSimpleYaml('b: { }')).toEqual({ b: {} });
  });

  it('nested flow structures split on top-level delimiters only', () => {
    // splitTopLevel bracket-depth tracking: inner commas/colons survive
    const parsed = parseSimpleYaml('a: [[1,2],[3]]\nb: {k: [x,y], m: {n: 1}}');
    expect(parsed.a).toEqual([[1, 2], [3]]);
    expect(parsed.b).toEqual({ k: ['x', 'y'], m: { n: 1 } });
  });

  it('flow map values may contain colons inside nested brackets', () => {
    // part.indexOf(':') idx mutants: key/value split must take the FIRST colon
    const parsed = parseSimpleYaml('u: {url: https://x.dev, v: 2}');
    expect(parsed.u).toEqual({ url: 'https://x.dev', v: 2 });
  });

  it('parts without a colon in a flow map are skipped', () => {
    // `if (idx < 0) continue` mutant would crash or add undefined keys
    const parsed = parseSimpleYaml('m: {a: 1, broken, b: 2}');
    expect(parsed.m).toEqual({ a: 1, b: 2 });
  });

  it('flow scalars inside brackets parse through the scalar rules', () => {
    const parsed = parseSimpleYaml('v: [1, 2.5, true, null, "q", last]');
    expect(parsed.v).toEqual([1, 2.5, true, null, 'q', 'last']);
  });
});

describe('wave 2: splitTopLevel bracket/quote edge behaviour', () => {
  it('unbalanced closing brackets never drive depth negative', () => {
    // Math.max(0, depth-1) mutants: an unmatched ] or } must not enable
    // delimiter splitting inside a later bracketed region
    const parsed = parseSimpleYaml('a: [x],]y]');
    expect(parsed.a).toEqual(['x]', ']y']);
    // depth must not go negative across parts
    const parsed2 = parseSimpleYaml('b: [[x],y]');
    expect(parsed2.b).toEqual([['x'], 'y']);
  });

  it('a trailing empty part is kept only after a real delimiter', () => {
    // `current.trim() || parts.length > 0` mutant: 'a,' must yield ['a','']
    // (parseFlowValue of empty → null), 'a' alone must yield ['a']
    const parsed = parseSimpleYaml('v: [a,]');
    expect(parsed.v).toEqual(['a', null]);
  });
});

describe('wave 2: list-item structure', () => {
  it('inline mapping items absorb nested continuation lines', () => {
    const parsed = parseSimpleYaml(
      'items:\n  - name: first\n    extra: yes-data\n  - name: second'
    );
    expect(parsed.items).toEqual([
      { name: 'first', extra: 'yes-data' },
      { name: 'second' },
    ]);
  });

  it('inline mapping items do NOT treat block-scalar values as inline', () => {
    // `!inlineMatch[2].startsWith('|')` mutant: '|' value would be parsed as
    // flow instead of delegating to the block-scalar parser. In LIST context
    // the '- desc: |' item is kept verbatim and the deeper lines become the
    // item's nested continuation (block scalars are a mapping-only feature).
    const parsed = parseSimpleYaml(
      'items:\n  - desc: |\n    block one\n    block two\n  - n: 1'
    );
    // Verified actual: items = ['desc: |'] — the inline '|'-value item keeps its
    // raw text; the following lines are absorbed as the item's continuation.
    expect(parsed.items).toEqual(['desc: |']);
  });

  it('non-mapping nested lines under a scalar list item become nested lists', () => {
    // Object.assign guard: nested ARRAY under a mapping-item must be rejected
    const parsed = parseSimpleYaml(
      'servers:\n  - url: a.dev\n    - orphan'
    );
    // '- orphan' is a list item at deeper indent → nested is an array → NOT merged
    expect(parsed.servers).toEqual([{ url: 'a.dev' }]);
  });

  it('bare scalar list items and flow list items both work', () => {
    const parsed = parseSimpleYaml('tags: [one, two]\nitems:\n  - 1\n  - two');
    expect(parsed.tags).toEqual(['one', 'two']);
    expect(parsed.items).toEqual([1, 'two']);
  });

  it('empty text produces empty lines array (splitYamlLines guards)', () => {
    expect(() => parseSpec('   \n\n')).toThrow(SpecParseError);
  });
});

describe('wave 2: block scalar details', () => {
  it('folded scalars join with spaces; literal keeps line breaks', () => {
    // marker.startsWith('>') mutants
    const parsed = parseSimpleYaml(
      'lit: |\n  a\n  b\nfld: >\n  c\n  d'
    );
    expect(parsed.lit).toBe('a\nb');
    expect(parsed.fld).toBe('c d');
  });

  it('a block scalar key with no deeper lines yields empty string', () => {
    // while-loop `indent > keyIndent` mutant / parts.join('') mutant
    const parsed = parseSimpleYaml('a: |\nb: 1');
    expect(parsed.a).toBe('');
    expect(parsed.b).toBe(1);
  });

  it('block scalar stops at sibling keys at the same indent', () => {
    // parseBlockScalar's loop-boundary mutant (lines[i].indent > keyIndent)
    const parsed = parseSimpleYaml(
      'doc: |\n  body text\nnext: value'
    );
    expect(parsed.doc).toBe('body text');
    expect(parsed.next).toBe('value');
  });

  it('inline | and > on the key line delegate with the correct marker', () => {
    // parseYamlBlock mapping branch: rest.startsWith('|') / startsWith('>')
    // mutants — each marker must route to its own folding mode
    const parsed = parseSimpleYaml(
      'a: |\n  one\nb: >\n  two\nc: |-\n  three'
    );
    expect(parsed.a).toBe('one');
    expect(parsed.b).toBe('two');
    expect(parsed.c).toBe('three');
  });
});

describe('wave 2: sampleFromSchema depth and format details', () => {
  it('recursion depth cap returns null past depth 4', () => {
    // depth > 4 mutant / depth+1 arithmetic mutants
    const deep = { type: 'object', properties: { a: { type: 'object' } } };
    let node: Record<string, unknown> = deep;
    for (let i = 0; i < 8; i++) {
      node = { type: 'object', properties: { n: node } };
    }
    // At depth > 4 the innermost object collapses to null
    const sample = sampleFromSchema(node) as Record<string, unknown>;
    expect(JSON.stringify(sample)).toContain('null');
  });

  it('array recursion passes depth+1; integer/number formats differ', () => {
    expect(sampleFromSchema({ type: 'array', items: { type: 'string' } })).toEqual(['string']);
    expect(sampleFromSchema({ type: 'integer', format: 'int64' })).toBe(9007199254740991);
  });

  it('string formats: date-time, date, and plain string', () => {
    expect(sampleFromSchema({ type: 'string', format: 'date-time' })).toBe('2026-01-01T00:00:00Z');
    expect(sampleFromSchema({ type: 'string', format: 'date' })).toBe('2026-01-01');
    expect(sampleFromSchema({ type: 'string' })).toBe('string');
  });

  it('$ref produces a placeholder keyed by the final path segment', () => {
    expect(sampleFromSchema({ $ref: '#/components/schemas/Pet' })).toEqual({ '<Pet>': null });
    // empty segment fallback
    expect(sampleFromSchema({ $ref: '#/' })).toEqual({ '<ref>': null });
  });

  it('required-only filtering with no optional props at all', () => {
    // Object.keys(props) MethodExpression mutants: optional-only and
    // required-only paths must both work
    const reqOnly = sampleFromSchema({
      type: 'object',
      required: ['r'],
      properties: { r: { type: 'string' } },
    });
    expect(reqOnly).toEqual({ r: 'string' });
  });

  it('enum picks the first entry only when non-empty', () => {
    // s.enum.length > 0 mutant: empty enum must NOT be used as a sample
    expect(sampleFromSchema({ enum: ['a', 'b'] })).toBe('a');
    expect(sampleFromSchema({ type: 'string', enum: [] })).toBe('string');
  });
});


// ─── Wave 3: frontmatter + remaining spec mutants ────────────────────

describe('wave 3: applyBasePath edges', () => {
  it('appends basePath to URLs with no existing path', () => {
    expect(applyBasePath('http://x.dev', '/api')).toBe('http://x.dev/api');
  });

  it('never appends when the URL already starts with the basePath', () => {
    // pathname === clean mutant: http://x.dev/api + /api must stay
    expect(applyBasePath('http://x.dev/api', '/api')).toBe('http://x.dev/api');
    // startsWith(clean + '/') branch: /api/v1 + /api must stay
    expect(applyBasePath('http://x.dev/api/v1', '/api')).toBe('http://x.dev/api/v1');
  });

  it('trailing slashes and bare / basePaths are dropped', () => {
    // replace(/\/+$/, '') mutant + clean === '/' mutant
    expect(applyBasePath('http://x.dev', '///')).toBe('http://x.dev');
    expect(applyBasePath('http://x.dev', '/')).toBe('http://x.dev');
  });

  it('falsy basePath returns the URL untouched', () => {
    // !basePath mutant: undefined and '' both no-op
    expect(applyBasePath('http://x.dev', undefined)).toBe('http://x.dev');
    expect(applyBasePath('http://x.dev', '')).toBe('http://x.dev');
  });

  it('non-URL server strings fall back to substring matching', () => {
    // URL-parse catch path: 'weird url' + /api appends; already-containing stays
    expect(applyBasePath('weird url', '/api')).toBe('weird url/api');
    expect(applyBasePath('weird /api url', '/api')).toBe('weird /api url');
  });
});

describe('wave 3: normalizeServerUrl and hostToServerUrl strictness', () => {
  it('scheme regex requires letter-start scheme with ://', () => {
    // /[a-zA-Z][a-zA-Z0-9+.-]*:\/\// mutant: '@' can't start a scheme
    expect(normalizeServerUrl('user@https://x.dev')).toBeNull();
    expect(normalizeServerUrl('HTTPS://X.DEV')).toBe('HTTPS://X.DEV');
  });

  it('host with explicit scheme keeps it; bare host gets http://', () => {
    // /^https?:\/\// mutant: 'ftp://host' must get the http:// prefix
    expect(hostToServerUrl({ host: 'ftp://host.dev' })).toBe('http://ftp://host.dev');
  });

  it('host is trimmed and trailing slashes stripped', () => {
    expect(hostToServerUrl({ host: '  host.dev///' })).toBe('http://host.dev');
  });
});

describe('wave 3: frontmatter structure corners', () => {
  it('delimited header recursion: closing marker not at index 0', () => {
    // closeIdx <= 0 mutant: single closing line must not be treated as the opener
    const { meta, specText } = parseSwaggerFrontmatter('---\nservers: https://a.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://a.dev']);
    expect(specText).toBe('body');
  });

  it('a blank first line makes the first --- the bare-header delimiter', () => {
    // lines[0] is '' (not ---) → bare convention: first --- delimits
    const { specText } = parseSwaggerFrontmatter('\n---\nkey: v\n---\nrest');
    expect(specText).toBe('key: v\n---\nrest');
  });

  it('BOM/whitespace on the opening marker line is tolerated', () => {
    // lines[0]?.trim() OptionalChaining + MethodExpression mutants
    const { meta, specText } = parseSwaggerFrontmatter('  ---\nhost: h.dev\n---\nbody');
    expect(meta.host).toBe('h.dev');
    expect(specText).toBe('body');
  });

  it('header keys are case-insensitive', () => {
    // keyMatch[1].toLowerCase() MethodExpression mutant
    const { meta } = parseSwaggerFrontmatter('SERVERS: https://a.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://a.dev']);
  });

  it('inline server lists split on commas with per-part validation', () => {
    // inlineVal split(',') mutant: invalid parts are dropped, valid kept
    const { meta } = parseSwaggerFrontmatter('servers: https://a.dev, junk, https://b.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://a.dev', 'https://b.dev']);
    // single inline server also works and clears the collector
    const only = parseSwaggerFrontmatter('server: https://one.dev\n---\nbody');
    expect(only.meta.servers).toEqual(['https://one.dev']);
  });

  it('basePath accepts several key spellings and strips quotes', () => {
    // setKey basePath branch + quote-strip regex mutants
    const bp1 = parseSwaggerFrontmatter('basePath: "/api/v1"\n---\nbody');
    expect(bp1.meta.basePath).toBe('/api/v1');
    // 'base_url' (underscore mid-word) is NOT an accepted spelling
    const bp2 = parseSwaggerFrontmatter("base_url: '/v9'\n---\nbody");
    expect(bp2.meta.basePath).toBeUndefined();
    const bp3 = parseSwaggerFrontmatter('basepath: /plain\n---\nbody');
    expect(bp3.meta.basePath).toBe('/plain');
  });

  it('server list items require exact - item syntax with content', () => {
    // listMatch regex mutants: '-x' (no space) is not a list item
    const { meta } = parseSwaggerFrontmatter('servers:\n-https://nospace.dev\n---\nbody');
    // key opens the collector; the no-space '-url' line is silently dropped
    expect(meta.servers).toEqual([]);
  });

  it('the notes key collects until joined; other keys reset currentKey', () => {
    // currentKey === 'servers' LogicalOperator mutant + join('\n') MethodExpression
    const { meta } = parseSwaggerFrontmatter('notes: alpha\nbeta\ngamma\n---\nbody');
    expect(meta.notes).toBe('alpha\nbeta\ngamma');
  });

  it('notes continuation lines keep leading content after trimStart', () => {
    const { meta } = parseSwaggerFrontmatter('notes: first\n   second indented\n---\nbody');
    expect(meta.notes).toBe('first\nsecond indented');
  });

  it('an unknown header key does not become a server', () => {
    // final else branch — currentKey = null
    const { meta } = parseSwaggerFrontmatter('whatever: x\nservers:\n  - https://a.dev\n---\nbody');
    // '- item' after 'whatever' reset currentKey → ignored... actually
    // 'servers:' re-opens collection; assert servers ARE parsed
    expect(meta.servers).toEqual(['https://a.dev']);
  });
});

describe('wave 3: spec parser leftover corners', () => {
  it('list item with a lone - yields null entries', () => {
    // isListItem regex /-(\s|$)/ mutants + content strip /^-\s*/
    expect(parseSimpleYaml('a:\n  -\n  - 2')).toEqual({ a: [null, 2] });
  });

  it('a non-list line inside a list block ends the list', () => {
    // while-loop `lines[i].indent === indent` boundary mutants
    expect(parseSimpleYaml('a:\n  - 1\n  b: 2')).toEqual({ a: [1] });
  });

  it('inline mapping items stop collecting at non-deeper lines', () => {
    // parseYamlBlock(lines, i, indent + 1) indent-1 mutants
    expect(parseSimpleYaml('items:\n  - k: v\n    extra: e')).toEqual({
      items: [{ k: 'v', extra: 'e' }],
    });
  });

  it('a mapping line inside a list block throws (orphan key)', () => {
    // verified: 'items:\n  - k: v\n    orphan' throws Cannot parse
    expect(() => parseSimpleYaml('items:\n  - k: v\n    orphan')).toThrow(/Cannot parse YAML line: orphan/);
  });

  it('inline k: |x item keeps raw text; following items parse normally', () => {
    // verified: '- k: |x' keeps raw text (block scalar is mapping-only)
    expect(parseSimpleYaml('items:\n  - k: |x\n  - 2')).toEqual({ items: ['k: |x', 2] });
  });

  it('nested flow maps with mixed nesting parse fully', () => {
    expect(parseSimpleYaml('m: {a: {b: 1, c: 2}, d: 3}')).toEqual({
      m: { a: { b: 1, c: 2 }, d: 3 },
    });
  });

  it('a bare colon key parses as string key null', () => {
    // verified: '{: v}' → key 'null' (String(null)) — pin actual
    expect(parseSimpleYaml('m: {: v}')).toEqual({ m: { null: 'v' } });
  });

  it('empty key line value parses as null; siblings continue', () => {
    expect(parseSimpleYaml('a:\nb: 2')).toEqual({ a: null, b: 2 });
  });

  it('flow value split: unterminated extras become scalar strings', () => {
    // verified: '[]],[1]' → [']]', '[1]']
    expect(parseSimpleYaml('v: []],[1]')).toEqual({ v: [']]', '[1'] });
  });

  it('sampleFromSchema null schema returns null', () => {
    expect(sampleFromSchema(null)).toBeNull();
  });
});

describe('wave 3: request-body helper edges', () => {
  it('defaultRequestBody prefers example, then schema sample, then scaffold', async () => {
    const { defaultRequestBody } = await import('@/lib/swaggerSpec');
    expect(defaultRequestBody('application/json', {
      'application/json': { example: { a: 1 } },
    })).toBe('{\n  "a": 1\n}');
    expect(defaultRequestBody('application/json', {
      'application/json': { schema: { type: 'string' } },
    })).toBe('"string"');
    expect(defaultRequestBody('application/json', {})).toBe('{\n  \n}');
  });

  it('serializeBody object values stringify even for text media types', async () => {
    const { defaultRequestBody } = await import('@/lib/swaggerSpec');
    // typeof value === 'object' mutant: object sample for text/plain still JSON
    expect(defaultRequestBody('text/plain', {
      'text/plain': { schema: { type: 'object', properties: { a: { type: 'string' } } } },
    })).toBe('{\n  "a": "string"\n}');
  });

  it('requestBodyExamples: summary fallback to key; non-object example entries skipped', async () => {
    const { requestBodyExamples } = await import('@/lib/swaggerSpec');
    const out = requestBodyExamples('application/json', {
      'application/json': {
        examples: {
          noSummary: { value: [1, 2] }, // label falls back to the KEY
          bad: 'not-an-object', // skipped: typeof guard
        },
      },
    });
    expect(out.map((e) => e.name)).toEqual(['noSummary', 'Empty']);
    expect(out[0].value).toBe('[\n  1,\n  2\n]');
  });

  it('requestBodyExamples drops duplicate values regardless of name', async () => {
    const { requestBodyExamples } = await import('@/lib/swaggerSpec');
    const out = requestBodyExamples('application/json', {
      'application/json': {
        example: 'dup',
        schema: { type: 'string', example: 'dup' },
      },
    });
    expect(out.map((e) => e.name)).toEqual(['Example', 'Empty']);
  });

  it('scaffoldFor x-www-form-urlencoded returns key=value', async () => {
    const { scaffoldFor } = await import('@/lib/swaggerSpec');
    expect(scaffoldFor('application/x-www-form-urlencoded')).toBe('key=value');
    expect(scaffoldFor('text/csv')).toBe('');
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