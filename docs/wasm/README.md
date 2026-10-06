# WebAssembly language support

Code blocks can run in the browser through WebAssembly. Each language is a plugin: it registers itself when imported, and its interpreter is fetched only when a block of that language runs.

| Language | Doc | Vendored builder | Contract |
| --- | --- | --- | --- |
| PHP | [docs/FEATURES.md](../FEATURES.md) | `php-wasm-builder` | vendor.json (no provenance manifest) |
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

## The PHP builder

PHP is built by [php-wasm-builder](https://github.com/Lewiscowles1986/php-wasm-builder), a fork of [derickr/php-wasm-builder](https://github.com/derickr/php-wasm-builder). `docker-bake.hcl` on the `feat/parallel-build-multiple-php` branch builds each version in parallel and exports `php-web.mjs` and `php-web.wasm` (plus an `php-cli.mjs` for Node) into `builds/auto/build-<series>/`.

Its versions match the vendored bundles exactly: 5.4.45, 7.4.33, 8.0.30, 8.1.34, 8.2.33, 8.3.33, 8.4.25, 8.5.10.

## Known inconsistency: PHP

PHP's bundles are now vendored through `scripts/vendor-wasm.mjs` like the others, so they carry `vendor.json` and gzipped payloads. Two gaps remain, both because the builder does not produce the inputs:

- **No `manifest.json`** — `php-wasm-builder` emits only the two build artifacts, so there is no recorded source URL, hash, compiler identity or capability list to vendor. A manifest could be generated from the builder at build time; it does not exist today.
- **No licence files or third-party notices** — the builder does not emit them either.

So PHP is verified as far as its inputs allow (file hashes from `vendor.json`, and that the payload is really WebAssembly), but it has no provenance record, unlike Ruby, Python and Elixir.

## Size

| Language | Bundles | Vendored | Notes |
| --- | ---: | ---: | --- |
| PHP | 8 | ~18 MB | gzipped; no provenance manifest |
| Python | 17 | ~72 MB | gzipped |
| Ruby | 28 | ~124 MB | gzipped |
| Elixir | 1 | ~20 MB | gzipped |

All of it is tracked in the repository. The deployed site is smaller: only the languages a build enables are copied into `dist/`.
