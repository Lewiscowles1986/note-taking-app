# Design: make the swagger parsers terminate structurally, to cut Stryker timeouts

Branch: `fix/stryker-disable-type-checks-scope`
Date: 2026-10-06

## Problem

The merged 20-shard mutation run (`reports/mutation/mutation.json`) reports
4,933 mutants: 3,381 killed, 937 survived, 589 no-coverage, **22 Timeout**.

Every one of the 22 timeouts is a **non-terminating loop**, not a slow test.
At `timeoutMS: 60000` and `concurrency: 4` they burn roughly 5.5 CPU-minutes
per full run, and swaggerSpec's shard alone burns ~225 s of wall time doing
nothing. No `timeoutMS` value recovers that time; only capping it bounds the
loss.

Nineteen of the twenty-two sit in two files:

| Site | Mutation | Mechanism |
|---|---|---|
| `swaggerSpec.ts:116` | `i--` | `ch = line[-1]` matches no branch; `i` walks backwards |
| `swaggerSpec.ts:174` | `i--` | same shape in `splitTopLevel` |
| `swaggerSpec.ts:253,258,268,275,278,290` | body → `{}` | emptying the body removes the only `i++` on that path; the `while` condition stays true |
| `swaggerSpec.ts:263,307` | `parseYamlBlock(lines, i-1)` | the returned index moves the caller backwards, so the outer `while` reprocesses the same line |
| `swaggerSpec.ts:341` | `keyIndex - 1` | `parseBlockScalar` returns an index *before* the caller's |
| `swaggerFrontmatter.ts:135` | drop `idx > 0` | `closeIdx` becomes the opening `---`; the rebuild re-emits `---`, so the recursion never bottoms out |

Verified empirically: the `swaggerFrontmatter.ts:135` mutant raises
`RangeError: Maximum call stack size exceeded`.

## Why this is worth doing beyond the mutant count

`swaggerSpec.ts` and `swaggerFrontmatter.ts` parse user-supplied frontmatter on
the main thread. Termination currently rests on mutable index arithmetic and a
single `idx > 0` predicate. The unbounded recursion at
`swaggerFrontmatter.ts:140` is reachable from a stray `---`. This is a latent
robustness bug, tracked separately; the fix below is the same work either way.

## Scope

**In:** `src/lib/swaggerSpec.ts`, `src/lib/swaggerFrontmatter.ts`.

**Out (deferred):** `crypto.ts` `b642ab`, `oidcAuth.ts` `b64urlDecode` and
`exportView.ts` `collectStyles` account for the other 3 timeouts; each is a
one-line iterator conversion. Deliberately excluded so the timeout delta from
this change stays attributable.

## Approach

Make it structurally impossible for a one-token mutation to stop loop
progress.

### 1. Iterate instead of indexing

- `stripComment` and `splitTopLevel`: `for (const ch of text)` — removes the
  `UpdateOperator` and `EqualityOperator` mutants at 116 and 174.
- Keep `parseFlowValue` / `parseScalar` unchanged; they do not hang.

Only ASCII delimiters are scanned (quote marks, `#`, `,`, brackets), so
code-point iteration cannot change behaviour. Surrogate pairs are never
compared against a delimiter here.

### 2. Move the advance into the loop header

`parseBlockScalar` and both `parseYamlBlock` loops: use `for (...; i++)`. A
`BlockStatement` mutant then loses data instead of spinning, converting a
timeout into an ordinary kill or survivor. Clamp every advance at the
`parseYamlBlock` call sites (263, 307) with `i = Math.max(i + 1, next)` so a
backwards-returning callee cannot reprocess a line.

### 3. Remove the load-bearing guard in `parseSwaggerFrontmatter`

Search for the closing marker in `lines.slice(1)` (offset by 1) and drop the
recursive rebuild. The `idx > 0` predicate stops being what keeps the function
finite, and depth becomes bounded by construction.

**This is an intentional behaviour change, not a pure refactor.** With two
adjacent markers (`'---\n---\nhost: h\n---'`) the recursive rebuild treats the
opening marker as the closer, so `host: h` lands in `meta` *and* stays in
`specText` — the same content counted twice. The rewrite yields an empty header
and leaves `host: h` in the spec, which is correct. No fixture in `src/` or
`e2e/` uses adjacent markers, so this was previously unexercised; it is pinned by
a test before the change so the flip is deliberate.

## Verification

- Before/after: re-run the two affected shards and compare `Timeout` count and
  wall time. Target 19 → 0.
- `npm test` stays green (~7.5 s, 447 tests).
- Covered by `src/test/swaggerSpec.test.ts` and
  `src/test/swaggerMutationKills.test.ts`; add an edge-case assertion for the
  opening-`---`-with-no-closing-marker path.
- No snapshot or Playwright baseline change expected (pure logic).
- Reproduce a shard locally under the TS6 shadow documented in
  [`docs/TESTING.md`](../TESTING.md):
  `npx stryker run --mutate "$(node -p "require('./.github/stryker-shards.json').shards[0]")"`.

## Deferred: Section 2 — shared validation

Survivors are dominated by hand-copied shape validation:
`ConditionalExpression` 472, `StringLiteral` 324, `LogicalOperator` 116,
`EqualityOperator` 92 — the `typeof x === 'string' ? x : default` pattern,
repeated across 18 modules (`oidcAuth.ts` has 33 `typeof` checks).

Extracting it into one tested module **relocates** roughly 500 mutants into one
file rather than deleting them. The benefit is that they become concentrated
and killable once, and the parsing modules stop being dragged down by guards
nobody asserts on. It is a large mechanical change touching persisted-data
semantics, and should land as its own commit after the timeout data above is
measured.

## Risks

- `i = Math.max(i + 1, next)` changes behaviour only for malformed input that
  previously looped forever; it cannot regress well-formed parsing.
- The `parseYamlBlock` recursion remains bounded but recursive; a depth limit
  is out of scope here and belongs with the robustness issue.
