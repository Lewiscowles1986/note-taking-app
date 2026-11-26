# PHP wasm bundles

PHP code blocks run through a WebAssembly build of the PHP embed SAPI. Unlike
Ruby and Python, the list of supported versions is **compiled into the app**:
nothing is fetched at runtime to discover it, and no `index.json` is shipped
under `public/`.

## Where things live

| Path | Purpose |
| --- | --- |
| `src/lib/phpWasm.manifest.json` | The version list: bundle versions, their directories, and the default |
| `src/lib/phpRunner.ts` | Imports that manifest; loads a bundle and runs code through `phpw_run` |
| `public/php-wasm/build-<series>.x/` | The vendored bundles, one per PHP line |
| `scripts/sync-php-wasm.mjs` | Regenerates both of the above from the builder |

Bundle directories are named after the **line**, matching the builder's output:
`build-8.4.x/` contains PHP 8.4.28 and `vendor.json` records the exact patch. A
patch release rewrites that directory rather than adding `build-8.4.29/`, so the
tree has one bundle per supported line.

## Updating the builds

PHP is built by [php-wasm-builder](https://github.com/Lewiscowles1986/php-wasm-builder),
a fork of [derickr/php-wasm-builder](https://github.com/derickr/php-wasm-builder).
Its `docker-bake.hcl` has one target per line and exports to
`builds/auto/build-<series>.x/`.

```sh
git clone https://github.com/Lewiscowles1986/php-wasm-builder.git ../php-wasm-builder
cd ../php-wasm-builder && docker buildx bake
```

Then, from this repository:

```sh
node scripts/sync-php-wasm.mjs
```

The script is deliberately strict:

- It requires the builder at `../php-wasm-builder` (override with `--builder <path>`).
- It checks that a remote actually points at
  `github.com/Lewiscowles1986/php-wasm-builder`, and otherwise prints the clone
  command and exits without copying anything.
- It requires a non-empty `builds/` directory, and says how to produce one when
  it is missing.
- It reads the PHP version from the compiled `php-web.wasm`
  (`X-Powered-By: PHP/<version>`) and rejects a build whose bake pin disagrees,
  so a stale checkout cannot ship.
- It drops `php-cli.mjs` / `php-cli.wasm`, which only the Node demo uses.
- It prunes bundle directories the matrix no longer produces, and refuses to
  continue if two builds resolve to the same line.
- It rewrites `src/lib/phpWasm.manifest.json` and sorts bundles oldest first.

Use `--dry-run` to see what would change, `--no-prune` to keep stale
directories, and `--default <version>` to pin a default other than the newest.

## Adding a PHP version

1. Add (or bump) a target in the builder's `docker-bake.hcl`.
2. `docker buildx bake` in the builder.
3. `node scripts/sync-php-wasm.mjs` here.

No TypeScript change is needed — the selector lists whatever the manifest
contains.

## Legacy bundles

`5.4.45` and `7.4.33` were vendored before the builder covered those lines, and
the current Dockerfile targets PHP 8.x only. They live in `build-5.4.x/` and
`build-7.4.x/`, are marked `source: "legacy"` in the manifest, and are preserved
by the sync script rather than regenerated. Removing them means deleting the
directory and the manifest entry together.

## Testing

`src/test/phpBundles.test.ts` checks every listed bundle against its
`vendor.json` hashes, asserts the payload is real WebAssembly and carries the
expected PHP version marker, and fails if `public/php-wasm/` contains a
`build-*` directory the manifest does not list. `src/test/phpRunner.test.ts`
covers the manifest-to-runner wiring.
