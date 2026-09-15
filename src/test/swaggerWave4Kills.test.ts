import { describe, it, expect } from 'vitest';
import {
  parseSimpleYaml,
  parseScalar,
  sampleFromSchema,
  requestBodyExamples,
  parseSpecObject,
  SpecParseError,
} from '@/lib/swaggerSpec';
import { parseSwaggerFrontmatter } from '@/lib/swaggerFrontmatter';

describe('wave 4: frontmatter header parsing boundaries', () => {
  it('closing-marker search starts AFTER index 0 (a second line --- is the close)', () => {
    // closeIdx <= 0 mutant: with ['---','servers:…','---','body'], closeIdx must
    // be 2 (not 0) — else meta would be empty.
    const { meta, specText } = parseSwaggerFrontmatter('---\nservers: https://a.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://a.dev']);
    expect(specText).toBe('body');
  });

  it('a closing marker AT index 0 (first line is bare-header delim) is not treated as an opener-close', () => {
    // '---' on line 0 → delimited case; findIndex(idx>0) skips index 0.
    // Header empty, everything after index 0 is spec.
    const { meta, specText } = parseSwaggerFrontmatter('---\nopenapi: 3.0.3');
    expect(meta).toEqual({});
    expect(specText).toBe('openapi: 3.0.3');
  });

  it('delimited header recomputes delimIdx over the stripped lines (closeIdx-1 mutant)', () => {
    // lines.slice(0, closeIdx) vs closeIdx-1: a header of 2 keys must keep both.
    const { meta } = parseSwaggerFrontmatter('---\nhost: h.dev\nbasePath: /v2\n---\nbody');
    expect(meta.host).toBe('h.dev');
    expect(meta.basePath).toBe('/v2');
  });

  it('bare header: the FIRST --- terminates even when a second one appears in the spec', () => {
    // delimIdx vs slice(delimIdx+1) mutants: spec keeps BOTH --- lines.
    const raw = 'servers: https://a.dev\n---\nopenapi: 3.0.3\n---\nend: marker';
    const { meta, specText } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://a.dev']);
    expect(specText).toBe('openapi: 3.0.3\n---\nend: marker');
  });

  it('no delimiter at all → whole input is the spec', () => {
    const raw = 'openapi: 3.0.3\ninfo: x';
    const { meta, specText } = parseSwaggerFrontmatter(raw);
    expect(meta).toEqual({});
    expect(specText).toBe(raw);
  });

  it('the delimited-case recursion re-parses the header as bare (l param identity)', () => {
    // lines.slice(1, closeIdx) MethodExpression mutants would shift header lines
    const { meta } = parseSwaggerFrontmatter('---\nservers:\n  - https://a.dev\n  - https://b.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://a.dev', 'https://b.dev']);
  });

  it('setKey inline-empty: bare "servers:" does NOT clear the collector', () => {
    // `if (inlineVal)` mutant: 'servers:' then a list item must still collect
    const { meta } = parseSwaggerFrontmatter('servers:\n  - https://a.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://a.dev']);
    // an empty inline list still initializes the array (key opens collector)
    const empty = parseSwaggerFrontmatter('servers:\nserver:\n---\nbody');
    expect(empty.meta.servers).toEqual([]);
  });

  it("'server' (singular) opens the same collector as 'servers'", () => {
    // key === 'servers' || 'server' LogicalOperator mutant
    const { meta } = parseSwaggerFrontmatter('server: https://one.dev\n---\nbody');
    expect(meta.servers).toEqual(['https://one.dev']);
    // block form too
    const block = parseSwaggerFrontmatter('server:\n  - https://two.dev\n---\nbody');
    expect(block.meta.servers).toEqual(['https://two.dev']);
  });

  it('a recognized key RESETS the collector: servers list after host is ignored', () => {
    // else-branch `state.currentKey = null` BlockStatement mutant: a 'host:'
    // line between the 'servers:' key and a list item must block the item.
    const { meta } = parseSwaggerFrontmatter('servers:\nhost: h.dev\n  - https://orphan.dev\n---\nbody');
    expect(meta.servers).toEqual([]); // collector opened by 'servers:', item dropped after reset
    expect(meta.host).toBe('h.dev');
  });

  it('notes key without inline value starts collection; inline value is the first line', () => {
    // `if (inlineVal)` mutant on the notes branch
    const { meta } = parseSwaggerFrontmatter('notes: first line\nsecond line\n---\nbody');
    expect(meta.notes).toBe('first line\nsecond line');
    const only = parseSwaggerFrontmatter('notes:\nfirst line\n---\nbody');
    expect(only.meta.notes).toBe('first line');
  });

  it('empty notesLines produce no notes field; join+trim mutant', () => {
    // state.notesLines.join('\n') MethodExpression mutant
    const { meta } = parseSwaggerFrontmatter('host: h.dev\n---\nbody');
    expect(meta.notes).toBeUndefined();
    // whitespace-only lines are trimmed away
    const ws = parseSwaggerFrontmatter('notes:   \n---\nbody');
    // 'notes:   ' → inlineVal is '' → collector opens, no lines → no notes
    expect(ws.meta.notes).toBeUndefined();
  });
});

describe('wave 4: scalar + flow interior details', () => {
  it('stripComment scans every character (i <= line.length boundary mutant)', () => {
    // A comment '#' as the LAST char must still be stripped
    expect(parseSimpleYaml('a: 1 #')).toEqual({ a: 1 });
    // a line that is ONLY a comment char at the end of a value
    expect(parseSimpleYaml('a: "x" #')).toEqual({ a: 'x' });
  });

  it('stripComment advances i+1 after quote toggles (i+1 ArithmeticOperator mutant)', () => {
    // ''"'' sequence: quote-state machine must resync; the value stays intact
    expect(parseSimpleYaml(`a: "it's # fine" # real`)).toEqual({ a: "it's # fine" });
  });

  it('quoted scalars with escapes: slice(1,-1) strips exactly one quote pair', () => {
    // trimmed.slice(1,-1) MethodExpression mutants
    expect(parseScalar('"plain"')).toBe('plain');
    expect(parseScalar("'single'")).toBe('single');
    // NOT stripped when unquoted
    expect(parseScalar('plain')).toBe('plain');
    // a quoted empty string is an empty string, not null
    expect(parseScalar('""')).toBe('');
    expect(parseScalar("''")).toBe('');
  });

  it('length>=2 guard: a lone quote char is NOT unquoted', () => {
    // trimmed.length >= 2 ConditionalExpression mutants
    expect(parseScalar('"')).toBe('"');
    expect(parseScalar("'")).toBe("'");
  });

  it('flow map parts slice exactly at the first colon (slice idx mutants)', () => {
    // part.slice(0, idx) / part.slice(idx + 1)
    expect(parseSimpleYaml('m: {k: v}')).toEqual({ m: { k: 'v' } });
    // colon INSIDE the value: the flow-map splitter takes the FIRST colon,
    // so 'a' → 'b: c' (the second colon belongs to the value)
    expect(parseSimpleYaml('u: {a:b: c}')).toEqual({ u: { a: 'b: c' } });
  });

  it('splitTopLevel: trailing-delimiter detection uses current.trim() OR parts.length', () => {
    // `current.trim() || parts.length > 0` mutants
    expect(parseSimpleYaml('v: [a, b,]')).toEqual({ v: ['a', 'b', null] });
    expect(parseSimpleYaml('v: [ ]')).toEqual({ v: [] });
    // a flow value that is ONLY whitespace: parts=[]
    expect(parseSimpleYaml('v: [,]')).toEqual({ v: [null, null] });
  });

  it('depth floors: a ] without [ and } without { do not enable delimiter splits', () => {
    // UpdateOperator depthSquare-- / depthCurly-- and Math.min(0, ..) mutants
    // '}' floored at 0, then '{' raises curly depth → the ',' sits INSIDE
    // a brace region and is not a split point
    expect(parseSimpleYaml('v: [}x{, y]')).toEqual({ v: ['}x{, y'] });
    expect(parseSimpleYaml('m: {]x[, k: 1}')).toEqual({ m: { ']x[, k': 1 } });
  });

  it('quote-state nesting in splitTopLevel: delimiter inside quotes is literal', () => {
    // !inSingle || !inDouble LogicalOperator mutant
    expect(parseSimpleYaml(`v: ["a,b", 'c,d', e]`)).toEqual({ v: ['a,b', 'c,d', 'e'] });
  });

  it('parseSpecObject root guard: Map is rejected only by instanceof Map (null vs non-object ordering)', () => {
    // L222-224 ConditionalExpression mutants: each guard clause is load-bearing
    expect(() => parseSpecObject(null)).toThrow(/must be an object/);
    expect(() => parseSpecObject(undefined)).toThrow(/must be an object/);
    expect(() => parseSpecObject(0)).toThrow(/must be an object/);
    expect(() => parseSpecObject(false)).toThrow(/must be an object/);
    expect(() => parseSpecObject([])).toThrow(/must be an object/);
  });
});

describe('wave 4: splitKey quoted keys and values', () => {
  it('strip-quote regex removes ONE leading and ONE trailing quote char', () => {
    // match[1].replace(/^["']|["']$/g, '') mutant: single-strip, not global
    expect(parseSimpleYaml('"k": v')).toEqual({ k: 'v' });
    // key containing a quote char mid-key is preserved
    expect(parseSimpleYaml('"a\\"b": v')).toEqual({ 'a\\"b': 'v' });
  });

  it('a quoted empty key is rejected; empty rest parses as null', () => {
    // if (!key) return null → mapping line parse error; rest === '' → null
    expect(() => parseSimpleYaml('"": v')).toThrow(SpecParseError);
    expect(parseSimpleYaml('k:')).toEqual({ k: null });
  });
});

describe('wave 4: sampleFromSchema arithmetic + requestBodyExamples dedup', () => {
  it('depth arithmetic: depth+1 propagates so depth>4 collapses', () => {
    // ArithmeticOperator depth-1 / depth+1 mutants
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'string' } } } } } } } } },
      },
    };
    // a→b→c→d→e: e is at depth 5 → null
    expect(sampleFromSchema(schema)).toEqual({ a: { b: { c: { d: { e: null } } } } });
  });

  it('a $ref with an empty last segment uses the whole ref (pop || ref mutant)', () => {
    // already covered partially; pin exact output
    expect(sampleFromSchema({ $ref: 'x' })).toEqual({ '<x>': null });
    // empty ref is falsy → not a $ref at all → default null
    expect(sampleFromSchema({ $ref: '' })).toBeNull();
    // trailing-slash ref: pop() === '' → whole ref used as the key
    expect(sampleFromSchema({ $ref: '#/components/' })).toEqual({ '<ref>': null });
  });

  it('requestBodyExamples: examples entries with value:null are listed (0 is a value)', () => {
    // `'value' in ex` vs ex.value truthiness — null value must survive
    const out = requestBodyExamples('application/json', {
      'application/json': {
        examples: { zero: { value: 0 }, nul: { value: null } },
      },
    });
    expect(out.map((e) => e.name)).toEqual(['zero', 'nul', 'Empty']);
    expect(out[0].value).toBe('0');
    expect(out[1].value).toBe('null');
  });

  it('requestBodyExamples: the Empty push is skipped when a prior entry equals the scaffold', () => {
    // `!out.some((e) => e.value === empty)` mutants (true/false/arrowfn)
    const out = requestBodyExamples('text/plain', {
      'text/plain': { examples: { blank: { value: '' } } },
    });
    expect(out.map((e) => e.name)).toEqual(['blank']);
  });

  it('requestBodyExamples: serializeBody of a non-JSON media type with a primitive', () => {
    // mediaType json test LogicalOperator: non-json + non-object → String(value)
    const out = requestBodyExamples('text/plain', {
      'text/plain': { example: 42 },
    });
    expect(out[0].value).toBe('42');
  });

  it('defaultRequestBody: falsy schema falls to scaffold (content[mediaType] OptionalChaining)', async () => {
    const { defaultRequestBody } = await import('@/lib/swaggerSpec');
    // entry exists but schema null → scaffold
    expect(defaultRequestBody('application/json', { 'application/json': { schema: null } })).toBe('{\n  \n}');
    // content undefined entirely
    expect(defaultRequestBody('application/json')).toBe('{\n  \n}');
  });
});
