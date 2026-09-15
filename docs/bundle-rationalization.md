# Bundle Rationalization — load-time budget and lazy-loading roadmap

Measured 2026-09-15 on `feat/swagger-block-msw` (vite build with sourcemaps,
analyzer: per-chunk source-map breakdown).

## Where the bytes are today

Total `dist/assets`: **~50 MB across 387 files** — but that number is mostly
*deferred* weight. What actually loads on first paint is:

| Chunk | Raw | gzip | What's in it |
| --- | --- | --- | --- |
| `index-*.js` (entry) | 516 KB | **163 KB** | react-dom 127K, dexie 95K, app src 84K, sonner 32K, lucide 20K, tailwind-merge 20K, radix-* ~45K |
| `index-*.js` (shiki core, preloaded with CodeBlock) | 197 KB | **62 KB** | shiki + vscode-textmate + oniguruma-to-es |
| CSS (entry) | 124 KB | 21 KB | Tailwind output |

**First-load JS ≈ 225 KB gzip** (entry + shiki core + CSS). Everything else is
lazy: Mermaid (684K), Model3D (564K), GeoJSON (192K), Bpmn (204K),
NoteViewer/markdown pipeline (332 KB), SwaggerBlock (32 KB + 4×4 KB body
forms), and ~300 Shiki language-grammar chunks fetched only when a fence of
that language is highlighted (the big ones: emacs-lisp 772K, cpp 768K,
cynefin 676K, wasm 608K).

### Key observations

1. **Swagger is already well-split.** `SwaggerBlock` is 32 KB raw / 10 KB gzip
   and only fetched when a note contains an `openapi|swagger|openapi3` fence.
   The body-form editors (JSON/text/file/multipart) are separate ~4 KB chunks
   each, loaded only when Try-it-out mounts a body editor. Nothing swagger
   related touches the entry chunk.
2. **The two `index-*.js` chunks are the load-time problem.** The second
   index chunk (197 KB) is Shiki's engine + core, pulled in by `CodeBlock`,
   which is on the critical path of every note render. Shiki is loaded
   eagerly-ish (dynamic import triggered on first note view, not first paint).
3. **Shiki grammars are individually huge and unbounded in count.** Any
   grammar ever rendered is cached by the browser but each is fetched on
   demand; the *build* cost (387 files) and cold-cache cost of a
   grammar-heavy note is the real temporal cost.

## Rationalization plan (ordered by value/effort)

### 1. Defer Shiki's engine until a note is actually viewed (quick win)
The 197 KB shiki-core index chunk is imported by `CodeBlock` at module scope.
Wrap the Shiki import chain behind the existing
`dynamic-import-on-first-highlight` pattern so the initial shell is
react-dom + dexie + app only (~163 KB gzip). Target: entry JS < 170 KB gzip.

### 2. Cap and virtualize grammar fetching
- Maintain an explicit `bundledLanguages` allowlist of the grammars the app
  actually documents (markdown, ts/tsx, js, json, yaml, bash, html, css,
  python, sql…). Everything else falls back to `text` highlighting — already
  the runtime fallback behavior.
- Result: the 387-file dist collapses to roughly the ~60 chunks that matter;
  download weight for a grammar-heavy note drops by megabytes.
- Keep the grammars out of the service-worker precache (they're
  runtime-cacheable on first use); only app-shell chunks belong in the SW
  precache list.

### 3. Split SwaggerBlock's rarely-used paths (already partially done)
- The body forms are already separate chunks. Next split candidates:
  - `MultipartBodyForm` + `FileBodyForm` are only needed for specs with
    those body kinds — mount-on-demand is already in place via
    `LazyBodyForm`; no further work needed.
  - The **Spec tab** (raw spec text with Shiki highlighting) can reuse the
    main CodeBlock editor instead of importing RequestBodyEditor — saves
    shipping two highlight pipelines into the SwaggerBlock chunk.
- Estimated saving: ~8–10 KB raw from SwaggerBlock; low priority.

### 4. Defer heavy libs until their UI action is pressed
| Feature | Current load trigger | Proposed trigger |
| --- | --- | --- |
| Mermaid render | note contains mermaid fence (already lazy) | keep |
| Model3D | note contains 3dmodel fence (already lazy) | keep |
| GeoJSON | note contains geojson fence (already lazy) | keep |
| KaTeX | any note view (katex 256 KB chunk) | render math lazily per-note |
| Export/import ZIP | Export menu open | already lazy via download flow |
| Encryption dialog | Encrypt button | already lazy |

The remaining wins are mostly in the *entry* chunk:

- **sonner (32 KB) + radix toast (11 KB)** — both are in the entry for toasts.
  Sonner alone could be replaced by the existing toast hook UI; medium effort.
- **lucide-react (20 KB)** — icon imports are per-icon already; ensure no
  barrel-file import pulls the whole set (it doesn't today; 20 KB is the
  tree-shaken size of used icons).
- **dexie (95 KB)** — unavoidable for IndexedDB; it *is* the local-first core.

### 5. Numbers to hold the line on (CI-enforceable)
Add a simple size check to CI (script comparing `dist/assets` first-load
set against a budget):

- entry JS ≤ 170 KB gzip
- shiki-core chunk (when required) ≤ 70 KB gzip
- SwaggerBlock + body forms ≤ 15 KB gzip total
- total dist size is *informational only* (grammar chunks are lazy)

## What this means for MSW + offline-first

The lazy-chunk strategy is **compatible** with offline-first as long as:

1. The service-worker precache contains the entry chunks + NoteViewer +
   markdown pipeline (the "shell" every note view needs).
2. Grammar chunks and feature blocks (Swagger/Mermaid/3D/GeoJSON) are
   **runtime-cached, not precached**: first online use fetches and caches
   them; after that they work offline. See
   [swagger-msw-offline-first.md](swagger-msw-offline-first.md) for the
   MSW design that sits on top of this.
3. Never code-split anything needed by the SW's own fetch handler.

## Re-measuring

```bash
npm run build -- --sourcemap
node /Users/lewiscowles/.vscode/tmp/tmp_vscode_2/analyze-chunk.cjs dist/assets/index-*.js.map
```

First-load budget check (the numbers this doc commits to):

```bash
# entry chunk gzips
for f in dist/assets/index-*.js; do gzip -c "$f" | wc -c; done
```

Keep both numbers under the targets in section 1/2; a PR that regresses them
should state why in the description.