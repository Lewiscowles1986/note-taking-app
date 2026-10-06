# Swagger Parser Termination Hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make it structurally impossible for a single-token mutation to stop
loop progress in `swaggerSpec.ts` / `swaggerFrontmatter.ts`, eliminating 19 of
the 22 Stryker timeouts and closing a reachable unbounded-recursion path.

**Architecture:** Refactor two pure parsers so every loop's advance lives in
the `for` header and every index write is clamped monotonic. A Stryker
`BlockStatement` mutant (body → `{}`) or `UpdateOperator` mutant (`i++` →
`i--`) then loses data or throws instead of spinning until the 60 s timeout.
Removes the load-bearing `idx > 0` predicate in `parseSwaggerFrontmatter`.

**Tech Stack:** TypeScript 7, Vitest, StrykerJS 10 (`@stryker-mutator/vitest-runner`), oxlint.

**Design doc:** [`docs/plans/2026-10-06-stryker-termination-hardening-design.md`](./2026-10-06-stryker-termination-hardening-design.md)

---

## The invariant

> **Rule 1 — an advance never lives in a loop body.** Every loop advances on
> every path, and the advance lives in the `for` header. Stryker's
> `BlockStatement` mutant replaces a body with `{}`, which deletes an in-body
> `i++` and hangs the loop.
>
> **Rule 2 — a returned index is the loop counter, never a derived
> expression.** Stryker's `ArithmeticOperator` mutant turns `+` into `-`. A
> derived return like `keyIndex + 1 + parts.length` becomes
> `keyIndex + 1 - parts.length`, which for `parts.length === 0` lands *before*
> the caller's position — and a backwards landing position hangs the caller's
> loop. A counter reports real progress and leaves no expression to mutate.

Both rules were learned from execution, not reasoning: an under-advance hangs
the test process with no output at all, so a violation here surfaces as a
Stryker timeout rather than a failing assertion.

Verify the invariant by inspection at the end of every task:

```bash
cd /Users/lewiscowles/Projects/personal/note-taking-app/.worktrees/fix-stryker-disable-type-checks
grep -n "for (let\|while (" src/lib/swaggerSpec.ts src/lib/swaggerFrontmatter.ts
```

Expected at the end: only `for (let …; …; i++)` headers, no bare `while`.

**Run every test command under `timeout`.** An under-advance (index moving
backwards or not at all) hangs the process and produces *no output at all*
rather than a failing assertion — verified empirically. Without `timeout`, a
mistake silently consumes your whole turn instead of reporting an error:

```bash
timeout 300 npm test
timeout 120 npx vitest run src/test/swaggerSpec.test.ts
```

---

## Task 1: Characterization tests

Pin current behaviour before touching anything, including the case that
currently relies on the `idx > 0` predicate.

**Files:**
- Modify: `src/test/swaggerFrontmatter.test.ts`
- Modify: `src/test/swaggerSpec.test.ts`

**Step 1: Add the frontmatter edge-case tests**

Append inside the existing `describe('parseSwaggerFrontmatter', …)` block in
`src/test/swaggerFrontmatter.test.ts`:

```ts
  it('treats an opening marker with no closing marker as an empty header', () => {
    const { meta, specText } = parseSwaggerFrontmatter('---\ntitle: x\nopenapi: 3.0.0');
    expect(meta).toEqual({});
    expect(specText).toBe('title: x\nopenapi: 3.0.0');
  });

  it('does not treat the opening marker as the closing marker', () => {
    // Regression guard: if the closing search may match index 0, the rebuild
    // re-emits '---' and parseSwaggerFrontmatter recurses without bound.
    const raw = '---\ntitle: x\n---\nopenapi: 3.0.0\n';
    const { meta, specText } = parseSwaggerFrontmatter(raw);
    expect(meta).toEqual({});
    expect(specText).toBe('openapi: 3.0.0\n');
  });

  it('parses keys between a matched marker pair', () => {
    const raw = '---\nservers: https://api.dev\n---\nspec';
    const { meta, specText } = parseSwaggerFrontmatter(raw);
    expect(meta.servers).toEqual(['https://api.dev']);
    expect(specText).toBe('spec');
  });
```

**Step 2: Run them**

Run: `npx vitest run src/test/swaggerFrontmatter.test.ts`
Expected: PASS (the whole file, including the 3 new cases). These are
characterization tests — they pass now and must still pass after every
refactor. If any FAIL now, stop: your understanding of current behaviour is
wrong. Fix the expectation to match actual current output, not the code.

**Step 3: Add the parser termination-guard tests**

Append to `src/test/swaggerMutationKills.test.ts`:

```ts
describe('mutation kills: parser termination', () => {
  it('terminates on a block scalar at end of input', () => {
    expect(parseSimpleYaml('a: |\n  line')).toEqual({ a: 'line' });
  });

  it('terminates on a nested mapping at end of input', () => {
    expect(parseSimpleYaml('a:\n  b:\n    c: 1')).toEqual({ a: { b: { c: 1 } } });
  });

  it('terminates on a list item with an empty nested block', () => {
    // Rooted at a mapping: a sequence-rooted document is rejected by
    // parseSimpleYaml's top-level-mapping guard before any nested-block
    // advance runs, which would make this test unable to fail.
    expect(parseSimpleYaml('root:\n  - a:\n  - b: 2')).toEqual({ root: [{ a: null }, { b: 2 }] });
  });

  it('terminates on an unbalanced flow bracket', () => {
    expect(parseSimpleYaml('a: [1, [2')).toEqual({ a: '[1, [2' });
  });

  it('resumes at the right line after a nested mapping block', () => {
    // The sibling line only parses if the skip-ahead index lands on it.
    expect(parseSimpleYaml('a:\n  b:\n    c: 1\nd: 2')).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it('resumes at the right line after a list block scalar', () => {
    expect(parseSimpleYaml('a:\n  - |\n    line\n  - 2')).toEqual({ a: ['line', 2] });
  });
});
```

The last two exist because the other four all end the document immediately
after the nested content, so an off-by-one in the refactor's skip-ahead index is
never read. A guard that cannot observe the arithmetic it protects is worthless.

**Step 3b: Pin the adjacent-marker behaviour that Task 6 will intentionally change**

Add to `src/test/swaggerFrontmatter.test.ts`:

```ts
  it('currently re-parses the body as header when two markers are adjacent', () => {
    // Pre-refactor behaviour, pinned deliberately. The recursive rebuild treats
    // the opening marker as the closer, so `host: h` lands in meta AND stays in
    // specText — the same content counted twice. Task 6 flips this to meta {}.
    const { meta, specText } = parseSwaggerFrontmatter('---\n---\nhost: h\n---');
    expect(meta).toEqual({ host: 'h' });
    expect(specText).toBe('host: h\n---');
  });
```

**Step 4: Run them**

Run: `npx vitest run src/test/swaggerMutationKills.test.ts`
Expected: PASS. Adjust the expected values to the *actual* current output if a
case differs — these pin behaviour, they do not change it.

**Step 5: Commit**

```bash
git add src/test/swaggerFrontmatter.test.ts src/test/swaggerSpec.test.ts src/test/swaggerMutationKills.test.ts
git commit -m "test(swagger): characterize parser behaviour before termination refactor"
```

---

## Task 2: `stripComment` — remove the index

**Files:**
- Modify: `src/lib/swaggerSpec.ts:112-125`

**Step 1: Replace the loop**

```ts
function stripComment(line: string): string {
  // Remove trailing comments, but not inside quotes. Accumulating the prefix
  // keeps `out` identical to `line.slice(0, i)` without an index to mutate.
  let inSingle = false;
  let inDouble = false;
  let out = '';
  for (const ch of line) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      if (out === '' || /\s$/.test(out)) return out;
    }
    out += ch;
  }
  return line;
}
```

Why `out` rather than `line[i - 1]`: `out` is a prefix of `line`, so `out ===
''` is `i === 0` and `/\s$/.test(out)` is `/\s/.test(line[i - 1])`, exactly.
Returning `out` equals `line.slice(0, i)`. No index means no `i--` mutant and no
code-unit/`for...of` code-point mismatch on astral input.

**Step 2: Run the parser tests**

Run: `npx vitest run src/test/swaggerSpec.test.ts src/test/swaggerMutationKills.test.ts`
Expected: PASS. The Task 1 comment tests are the specific guard.

**Step 3: Commit**

```bash
git add src/lib/swaggerSpec.ts
git commit -m "refactor(swagger): strip comments without a mutable index"
```

---

## Task 3: `splitTopLevel` — iterate characters

**Files:**
- Modify: `src/lib/swaggerSpec.ts:174-175`

**Step 1: Swap only the loop header**

The body never uses `i`, so this is a pure swap:

```ts
  for (const ch of text) {
```

replacing

```ts
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
```

Only ASCII delimiters are compared (`'`, `"`, `[`, `]`, `{`, `}`, `delimiter`),
so code-point iteration cannot change results.

**Step 2: Run the tests**

Run: `npx vitest run src/test/swaggerSpec.test.ts src/test/swaggerMutationKills.test.ts`
Expected: PASS.

**Step 3: Commit**

```bash
git add src/lib/swaggerSpec.ts
git commit -m "refactor(swagger): split flow values by iterating characters"
```

---

## Task 4: `parseBlockScalar` — advance in the header

**Files:**
- Modify: `src/lib/swaggerSpec.ts:333-348`

**Step 1: Move the increment into the `for` header**

```ts
function parseBlockScalar(
  lines: YamlLine[],
  keyIndex: number,
  keyIndent: number,
  marker: string
): [string, number] {
  const folded = marker.startsWith('>');
  const parts: string[] = [];
  let i = keyIndex + 1;
  for (; i < lines.length && lines[i].indent > keyIndent; i++) {
    parts.push(lines[i].content);
  }
  const text = folded ? parts.join(' ') : parts.join('\n');
  return [text, i];
}
```

The increment is header-owned, so a `BlockStatement` mutant (body → `{}`) loses data
instead of looping forever.

**The return must be the actual counter, never a derived expression.** Do NOT write
`keyIndex + 1 + parts.length`: Stryker's `ArithmeticOperator` mutant rewrites it to
`keyIndex + 1 - parts.length`, and for an empty block scalar (`parts.length === 0`) that
returns `keyIndex` — a position *before* the caller's. The caller's map loop then re-reads
the same line forever and hangs. The original counter-based `return i` was structurally
immune, because it reports real progress and leaves no expression to mutate. This was found
by review and verified by execution.

Because `i` must survive to the `return`, it is declared outside the header
(`let i = …; for (; …; i++)`). That is deliberate, and the asymmetry with
`stripComment`/`splitTopLevel` (which drop the index entirely) belongs in a comment: this
loop has to hand a landing position back to its caller.

**Step 2: Run the tests**

Run: `timeout 120 npx vitest run src/test/swaggerSpec.test.ts src/test/swaggerMutationKills.test.ts`
Expected: PASS, including the new block-scalar termination test.

**Step 3: Commit**

```bash
git add src/lib/swaggerSpec.ts
git commit -m "refactor(swagger): own the block-scalar advance in the loop header"
```

---

## Task 5: `parseYamlBlock` — header-owned advance with a progress floor

**Files:**
- Modify: `src/lib/swaggerSpec.ts:250-284` (list block)
- Modify: `src/lib/swaggerSpec.ts:287-314` (map block)

**Step 1: Convert the list block**

`i++` moves into the header; skip-ahead paths set `i = Math.max(i, next - 1)` so
the header's `+1` lands exactly on `next`, and the floor guarantees at least one
position of progress per iteration no matter what a mutation makes `next`:

```ts
  if (first.isListItem) {
    const list: unknown[] = [];
    // `i` is hoisted so the return below can report the landing position; a
    // `for`-header `let` would be scoped to the loop.
    let i = index;
    for (; i < lines.length && lines[i].indent === indent && lines[i].isListItem; i++) {
      const item = lines[i];
      // `- key: value` (mapping inside a list item) → collect following lines
      // at deeper indent as the rest of that mapping.
      const inlineMatch = item.content.match(/^([^:{}[\]]+):\s*(.*)$/);
      if (inlineMatch && !inlineMatch[2].startsWith('|') && !inlineMatch[2].startsWith('>')) {
        const obj: Record<string, unknown> = {};
        obj[inlineMatch[1].trim()] = parseFlowValue(inlineMatch[2]);
        const [nested, next] = parseYamlBlock(lines, i + 1, indent + 1);
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          Object.assign(obj, nested);
        }
        list.push(obj);
        i = Math.max(i, next - 1);
        continue;
      }
      // Scalar item, flow value, or a nested block (| / >)
      const text = item.content;
      if (text.startsWith('|') || text.startsWith('>')) {
        const [scalar, next] = parseBlockScalar(lines, i, indent, text);
        list.push(scalar);
        i = Math.max(i, next - 1);
      } else {
        list.push(/^[{[]/.test(text) ? parseFlowValue(text) : parseScalar(text));
      }
    }
    return [list, i];
  }
```

The original incremented `i` *before* recursing (`i++; … parseYamlBlock(lines, i, …)`); the
recursion now uses `i + 1` directly, which is equivalent.

**Step 2: Convert the map block the same way**

```ts
  // A block of mapping entries
  const map: Record<string, unknown> = {};
  let i = index;
  for (; i < lines.length && lines[i].indent === indent && !lines[i].isListItem; i++) {
    const line = lines[i];
    const kv = splitKey(line.content);
    if (!kv) throw new SpecParseError(`Cannot parse YAML line: ${line.content}`);
    const [, key, rest] = kv;

    if (rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')) {
      const [scalar, next] = parseBlockScalar(lines, i, indent, rest);
      map[key] = scalar;
      i = Math.max(i, next - 1);
      continue;
    }

    if (rest === '') {
      // Value is a nested block (mapping or list) at deeper indent, or null.
      const [nested, next] = parseYamlBlock(lines, i + 1, indent + 1);
      map[key] = nested;
      i = Math.max(i, next - 1);
      continue;
    }

    map[key] = parseFlowValue(rest);
  }
  return [map, i];
```

**The map branch has two `i` increments in the original** — `i = next` on the nested paths
and a trailing `i++` on the plain-value path. The header now owns the plain-value increment,
so that trailing `i++` must be **removed**, not left in place. Double-advancing compiles
fine and silently drops lines.

**Step 3: Run the tests**

Run: `timeout 120 npx vitest run src/test/swaggerSpec.test.ts src/test/swaggerMutationKills.test.ts src/test/swaggerBlock.test.tsx`
Expected: PASS, including the nested-mapping and empty-nested-block
termination tests.

**Step 4: Verify the invariant — no bare `while` remains**

```bash
grep -n "while (" src/lib/swaggerSpec.ts
```
Expected: no output.

**Step 4b: Prove the floor is structurally safe, don't assume it**

`Math.max(i, next - 1)` is safe *because* `Math.max` can never return less than
`i`, and the header's `i++` then guarantees a full position of progress every
iteration — no matter what a mutation makes `next` be. Check the two mutants that
matter and report the outcome for each:

| Mutant | Result | Why |
|---|---|---|
| `next - 1` → `next + 1` | terminates | skips a line; wrong answer, not a hang |
| `Math.max` → `Math.min` | terminates | `next ≥ i + 1` always (both callees return at least their input index), so `min(i, next - 1) === i`, and `i++` still advances |
| `parseBlockScalar` `i++` → `i--` | terminates | see below |

**The floor, not the callee, is what saves the `i--` case.** A review claimed the
`Math.max` floor cannot rescue a mutated `parseBlockScalar`, on the grounds that
the callee throws before returning. That is wrong, and the mechanism matters
because Task 5 is what fixes it:

- In a `while (… ) { …; i = next; }` loop, a callee returning `next === i` makes
  `i = next` a no-op and the loop re-reads the same line forever. This is exactly
  how `a:\n  - |\n    line\n  - 2` hangs today.
- With the header-owned `for (…; i++)` plus `i = Math.max(i, next - 1)`, that same
  input advances: `next` of `1` clamps to `Math.max(1, 0) === 1`, the header's
  `i++` moves to `2`, and the line whose indent fails the guard ends the loop.

Verified by fuzz: 200,000 random `YamlLine[]` inputs through the Task 5 shape with
the `i--` mutant injected produced **0 hangs** (200,000 terminated). Prefer the
fuzz over reasoning here — the failure mode is a timeout, which no assertion
reports.

**Step 5: Commit**

```bash
git add src/lib/swaggerSpec.ts
git commit -m "refactor(swagger): give YAML block loops header-owned monotonic advances"
```

---

## Task 6: `parseSwaggerFrontmatter` — drop the recursion

**Files:**
- Modify: `src/lib/swaggerFrontmatter.ts:130-148`

**Step 1: Replace the case-1 branch**

Searching within `lines.slice(1)` makes the `idx > 0` predicate redundant
instead of load-bearing, and parsing the header directly removes the recursive
rebuild entirely:

```ts
export function parseSwaggerFrontmatter(raw: string): ParsedSwaggerBlock {
  const lines = raw.split('\n');

  // Case 1: starts with an opening `---` → find the CLOSING marker. Searching
  // the slice makes index 0 unreachable by construction, so the opening marker
  // can never be mistaken for the closing one.
  if (lines[0]?.trim() === '---') {
    const rest = lines.slice(1);
    const closeOffset = rest.findIndex((l) => l.trim() === '---');
    if (closeOffset < 0) {
      // Opening marker only — treat everything after it as the spec.
      return { meta: {}, specText: rest.join('\n') };
    }
    const { meta } = parseHeaderLines(rest.slice(0, closeOffset));
    return { meta, specText: rest.slice(closeOffset + 1).join('\n') };
  }
```

**Step 2: Extract the header loop into `parseHeaderLines`**

Cut lines 157-189 (the `headerLines` loop and its `return`) into a new
module-level function, and have case 2 call it too:

```ts
/** Parse header lines into frontmatter metadata. */
function parseHeaderLines(headerLines: string[]): ParsedSwaggerBlock {
  const state: KeyState = { meta: {}, currentKey: null, notesLines: [] };

  for (const line of headerLines) {
    const keyMatch = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (keyMatch) {
      setKey(state, keyMatch[1].toLowerCase(), keyMatch[2].trim());
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && state.currentKey === 'servers') {
      const url = normalizeServerUrl(listMatch[1]);
      if (url) {
        if (!state.meta.servers) state.meta.servers = [];
        state.meta.servers.push(url);
      }
      continue;
    }

    if (state.currentKey === 'notes') {
      state.notesLines.push(line.trimStart());
    }
  }

  if (state.notesLines.length > 0) {
    state.meta.notes = state.notesLines.join('\n').trim();
  }

  return { meta: state.meta, specText: '' };
}
```

Case 2 becomes:

```ts
  // Case 2: bare header terminated by the first `---` line.
  const delimIdx = lines.findIndex((l) => l.trim() === '---');

  if (delimIdx < 0) {
    return { meta: {}, specText: raw };
  }

  const { meta } = parseHeaderLines(lines.slice(0, delimIdx));
  return { meta, specText: lines.slice(delimIdx + 1).join('\n') };
}
```

`parseSwaggerFrontmatter` is now non-recursive and case 1 and case 2 share one
header parser. Because it returns `specText: ''`, callers must ignore that
field; only `meta` is used from it.

**Step 3: Confirm the function no longer calls itself**

```bash
grep -c "parseSwaggerFrontmatter(" src/lib/swaggerFrontmatter.ts
```
Expected: `1` (the export declaration only).

**Step 4: Run the tests**

Run: `npx vitest run src/test/swaggerFrontmatter.test.ts src/test/swaggerSpec.test.ts src/test/swaggerMutationKills.test.ts`

Expected: one **intentional** failure — the adjacent-marker test from Step 3b,
which pinned the old double-counting behaviour. **Update that test** to the new
value:

```ts
  it('treats the first marker after the opening one as the closer', () => {
    // Two adjacent markers mean an empty header: the second marker closes it, so
    // `host: h` stays in the spec rather than being parsed into meta as well.
    const { meta, specText } = parseSwaggerFrontmatter('---\n---\nhost: h\n---');
    expect(meta).toEqual({});
    expect(specText).toBe('host: h\n---');
  });
```

Then re-run and expect all PASS. Do not "fix" this by weakening the assertion in
the other direction — the empty-header result is the correct one, and the
double-count was the bug.

**Step 5: Commit**

```bash
git add src/lib/swaggerFrontmatter.ts
git commit -m "fix(swagger): parse frontmatter without unbounded recursion"
```

---

## Task 7: Bound the timeout cost

**Files:**
- Modify: `stryker.config.json`

**Step 1: Tighten the timeout**

```json
  "timeoutMS": 15000,
```

Rationale: this does **not** fix a hanging mutant — it caps how long one costs.
The suite runs in ~7.5 s wall, so 15 s is ample for the slowest single test
while halving worst-case waste. `timeoutFactor` still scales genuinely slow
tests from their measured net time.

**Step 2: Confirm the config still parses and Stryker accepts it**

```bash
npx stryker run --help >/dev/null && node -e "JSON.parse(require('fs').readFileSync('stryker.config.json','utf8')); console.log('config ok')"
```
Expected: `config ok`.

**Step 3: Commit**

```bash
git add stryker.config.json
git commit -m "ci(stryker): bound mutant timeout at 15s"
```

---

## Task 8: Verify the timeout delta

**Files:**
- Modify: `docs/TESTING.md` (only if measured numbers change)

**Step 1: Full suite must stay green**

Run: `npm test`
Expected: PASS. Green baseline at plan-writing time is **63 files / 1007 tests
/ ~6 s** (the 447-test figure in `docs/TESTING.md` is stale — that is a
separate docs issue, not part of this work). No snapshot changes.
Use `timeout 300 npm test` — see the timeout note under "The invariant".

**Step 2: Lint**

Run: `npm run lint`
Expected: PASS, no new findings.

**Step 3: Re-run the two affected shards under the TS6 shadow**

```bash
npm install --no-save --no-audit --no-fund "typescript@npm:@typescript/typescript6@^6.0.2"
npx stryker run --mutate "src/lib/swaggerSpec.ts"
npx stryker run --mutate "src/lib/swaggerFrontmatter.ts"
npm install   # restore typescript@7
```

Expected: **0 Timeout** in both `reports/mutation/mutation.json` runs, down
from 15 and 4. Record the wall time and total-score change for each.

**Step 4: Update the docs with measured numbers**

If the scores shifted, update the "Mutation testing" section of
`docs/TESTING.md`, including the per-module table and the timeout rationale.
Do not edit numbers you have not measured.

**Step 5: Commit**

```bash
git add docs/TESTING.md
git commit -m "docs(testing): record mutation results after termination hardening"
```

---

## Exit criteria

- 19 → 0 Stryker timeouts across the two files.
- `grep -n "while (" src/lib/swaggerSpec.ts` returns nothing.
- `grep -c "parseSwaggerFrontmatter(" src/lib/swaggerFrontmatter.ts` is `1`.
- `npm test` green; `npm run lint` clean.
- The frontmatter marker-pair, adjacent-marker and sibling-after-nested-block
  tests exist and pass, and each has been shown to fail when its target
  arithmetic is broken.
- No behaviour change for well-formed input, except the one intentional
  adjacent-marker fix documented above.

## Out of scope

The other 3 timeouts (`crypto.ts` `b642ab`, `oidcAuth.ts` `b64urlDecode`,
`exportView.ts` `collectStyles`) — each a one-line iterator conversion, kept
separate so this delta is attributable. Shared validation extraction (design
Section 2) is likewise deferred until these numbers are measured.
