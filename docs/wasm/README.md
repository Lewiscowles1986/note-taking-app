# WebAssembly language support

Code blocks can run in the browser through WebAssembly. Each language is a plugin: it registers itself when imported, and its interpreter is fetched only when a block of that language runs.

| Language | Doc | Vendored builder | Contract |
| --- | --- | --- | --- |
| PHP | [php.md](./php.md) | `php-wasm-builder` | compiled-in manifest + vendor.json (no provenance manifest) |
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

Bundles built by a sibling `*-wasm-builder` repository are vendored under `public/<language>-wasm/build-<version>/` by `scripts/vendor-wasm.mjs`, which writes two files (PHP uses `build-<series>.x/`; see [php.md](./php.md)):

- `manifest.json` — the build's provenance (source URL and hash, compiler, capabilities, file hashes), produced by the builder.
- `vendor.json` — what the runner needs: the loader module, its exported entry point, which assets are gzipped, and each file's size and hash.

Large assets are committed gzipped and decompressed in the browser with `DecompressionStream`. `scripts/build-wasm-index.mjs` then writes `public/<language>-wasm/index.json`, the catalog the version selector lists from, so a newly vendored bundle appears with no code change.

## The PHP builder

PHP is built by [php-wasm-builder](https://github.com/Lewiscowles1986/php-wasm-builder), a fork of [derickr/php-wasm-builder](https://github.com/derickr/php-wasm-builder). `docker-bake.hcl` builds each line in parallel and exports `php-web.mjs`, `php-web.wasm` and a Node-only `php-cli.mjs`/`php-cli.wasm` pair into `builds/auto/build-<series>.x/`.

PHP differs from the other languages in one way: its build directories are named after the **line**, not the patch (`build-8.4.x` holds PHP 8.4.28). The vendored tree keeps that shape, so a patch release replaces a bundle in place instead of accumulating a directory per patch.

### Syncing the builds

`scripts/sync-php-wasm.mjs` is the only supported way to update PHP bundles. It:

1. Requires a `php-wasm-builder` checkout at `../php-wasm-builder`, and refuses to run unless one of its remotes is `github.com/Lewiscowles1986/php-wasm-builder` — so a stray clone cannot get vendored.
2. Reads the PHP version out of each build's `php-web.wasm` (`X-Powered-By: PHP/<version>`) and cross-checks it against the `PHP_VERSION` pin in `docker-bake.hcl`, failing if the checkout and its output disagree.
3. Vendors each line with `scripts/vendor-wasm.mjs`, dropping the Node-only files the browser runner never loads.
4. Prunes any `public/php-wasm/build-*` directory the matrix no longer produces.
5. Rewrites `src/lib/phpWasm.manifest.json`, the list the runner is compiled with.

```sh
node scripts/sync-php-wasm.mjs              # sync everything
node scripts/sync-php-wasm.mjs --dry-run    # report changes only
node scripts/sync-php-wasm.mjs --default 8.5.13
```

If the checkout is missing the script prints the clone command and exits non-zero:

```sh
git clone https://github.com/Lewiscowles1986/php-wasm-builder.git ../php-wasm-builder
cd ../php-wasm-builder && docker buildx bake
```

### Adding a version

Add a target to the builder's `docker-bake.hcl`, run `docker buildx bake`, then re-run the sync script. Nothing in this repository needs editing: the new line appears in the version selector because the manifest is regenerated and compiled into the bundle.

### `src/lib/phpWasm.manifest.json`

```json
{
  "schema": 1,
  "language": "php",
  "default": "8.6.0",
  "bundles": [
    { "version": "8.4.28", "directory": "build-8.4.x", "source": "php-wasm-builder" },
    { "version": "5.4.45", "directory": "build-5.4.x", "source": "legacy" }
  ]
}
```

It is imported by `src/lib/phpRunner.ts`, so the version list ships with the code and the runner makes **no request to discover versions** — unlike Ruby and Python, which fetch `index.json` at runtime. A build that leaves a bundle out cannot advertise it, because the list and the vendored files come from the same sync run (`src/test/phpBundles.test.ts` asserts they agree).

`source: "legacy"` marks bundles from before the builder covered that line (PHP 5.4 and 7.4). The current Dockerfile targets 8.x only, so those are kept as-is and never regenerated; the sync script preserves them and lists them.

## Known inconsistency: PHP

PHP's bundles are vendored through `scripts/vendor-wasm.mjs` like the others, so they carry `vendor.json` and gzipped payloads. Two gaps remain, both because the builder does not produce the inputs:

- **No `manifest.json`** — `php-wasm-builder` emits only the build artifacts, so there is no recorded source URL, hash, compiler identity or capability list to vendor. A manifest could be generated from the builder at build time; it does not exist today.
- **No licence files or third-party notices** — the builder does not emit them either.

So PHP is verified as far as its inputs allow (file hashes from `vendor.json`, the version marker in the wasm, and that the payload is really WebAssembly), but it has no provenance record, unlike Ruby, Python and Elixir.

## Size

| Language | Bundles | Vendored | Notes |
| --- | ---: | ---: | --- |
| PHP | 9 | ~22 MB | gzipped; no provenance manifest |
| Python | 17 | ~72 MB | gzipped |
| Ruby | 28 | ~124 MB | gzipped |
| Elixir | 1 | ~20 MB | gzipped |

All of it is tracked in the repository. The deployed site is smaller: only the languages a build enables are copied into `dist/`.
