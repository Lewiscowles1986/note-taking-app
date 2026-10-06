# WebAssembly language support

Code blocks can run in the browser through WebAssembly. Each language is a plugin: it registers itself when imported, and its interpreter is fetched only when a block of that language runs.

| Language | Doc | Vendored builder | Contract |
| --- | --- | --- | --- |
| PHP | [docs/FEATURES.md](../FEATURES.md) | none | legacy, hand-vendored |
| Python | [python.md](./python.md) | `python-wasm-builder` | manifest + vendor + gzip |
| Ruby | [ruby.md](./ruby.md) | `ruby-wasm-builder` | manifest + vendor + gzip |
| Elixir | [elixir.md](./elixir.md) | `elixir-wasm-builder` | manifest + vendor + gzip |

## Enabling languages per build

Set `VITE_LANGUAGES` (comma-separated). The default is `js,php,python,ruby`; Elixir is opt-in because it needs cross-origin isolation that GitHub Pages cannot send.

```sh
VITE_LANGUAGES=php npm run build          # only PHP
VITE_LANGUAGES=php,ruby npm run build     # PHP and Ruby
```

A disabled language registers no runner and its wasm is left out of the built site, so the deploy ships only what it can run.

## The bundle contract

Bundles built by a sibling `*-wasm-builder` repository are vendored under `public/<language>-wasm/build-<version>/` by `scripts/vendor-wasm.mjs`, which writes two files:

- `manifest.json` — the build's provenance (source URL and hash, compiler, capabilities, file hashes), produced by the builder.
- `vendor.json` — what the runner needs: the loader module, its exported entry point, which assets are gzipped, and each file's size and hash.

Large assets are committed gzipped and decompressed in the browser with `DecompressionStream`. `scripts/build-wasm-index.mjs` then writes `public/<language>-wasm/index.json`, the catalog the version selector lists from, so a newly vendored bundle appears with no code change.

## Known inconsistency: PHP

PHP predates this contract and is the exception on every point. Its bundles were vendored by hand in "run PHP code blocks in the browser via wasm" (#57) and have:

- no `manifest.json` and no `vendor.json`,
- no licence files or third-party notices,
- uncompressed payloads (`php-web.wasm` is stored raw, so 8 bundles are ~49 MB that would be ~18 MB gzipped),
- a differently named loader (`php-web.mjs`).

There is also **no `php-wasm-builder`**, so PHP's bundles cannot be rebuilt or verified from source the way the other three can. The runner still works; this is a provenance and consistency gap, not a functional one. Bringing PHP onto the contract is tracked work, and would let it use the same vendoring script, integrity tests and version catalog as the rest.

## Size

| Language | Bundles | Vendored | Notes |
| --- | ---: | ---: | --- |
| PHP | 8 | ~49 MB | uncompressed (legacy) |
| Python | 17 | ~72 MB | gzipped |
| Ruby | 28 | ~124 MB | gzipped |
| Elixir | 1 | ~20 MB | gzipped |

All of it is tracked in the repository. The deployed site is smaller: only the languages a build enables are copied into `dist/`.
