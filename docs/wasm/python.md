# Run Python in your notes

Python code blocks run in the browser through a vendored CPython WebAssembly build. Press **Run** under the block to execute it; the output appears below the code.

```python
def greet(name):
    return f"Hello, {name}!"

print(greet("Ada"))
print(sum(range(10)))
```

## Choose or pin a version

A version selector next to **Run** lists every build that is present. A build that is missing is hidden rather than failing at run time.

Pin a version for a single block with a `version:` frontmatter line:

```python
version: 3.10.21
---
import sys
print(sys.version)
```

## Available lines

The matrix spans Python 2.7 through 3.15 (the latest patch of each major.minor line). The default is the newest stable build, `3.15.0`.

```python
import sys, json
print(json.dumps({"version": sys.version.split()[0], "platform": sys.platform}))
```

## Limits

Each block runs once and then exits; the interpreter is not re-entered, so state does not carry between blocks. Files live in an ephemeral in-memory filesystem. Threads, sockets, dynamic extension loading, `pip` and `micropip` are not available in these builds — `sqlite3`, `zlib`, `bz2` and `decimal` are compiled in.

```python
import sqlite3, zlib, decimal
print("sqlite3", sqlite3.sqlite_version)
print("zlib", zlib.ZLIB_VERSION)
print("decimal", decimal.__name__)
```

The bundles are built by the separate [python-wasm-builder](https://github.com/lewiscowles-netizen/python-wasm-builder) repository and vendored into `public/python-wasm/`. They are loaded on demand with a dynamic `import()`, so nothing is fetched until a Python block actually runs.

## Replacing a build

A new CPython release is picked up by vendoring its bundle, then moving the selector's default. Point the builder at the release, then run from the repository root:

```sh
git worktree add .worktrees/python-3.15 -b feat/python-3.15
node scripts/vendor-wasm.mjs \
  --from ../python-wasm-builder/builds/build-3.15.0 \
  --to public/python-wasm/build-3.15.0 \
  --loader python.mjs --api default --version 3.15.0 \
  --drop smoke.json,smoke.mjs
```

`--from` is the builder's output directory, named for the exact release. `--to` is the bundle directory the runner will fetch, whose `build-` suffix is the *directory* name — keep it equal to the version unless the build's `manifest.id` says otherwise. `--drop` discards the builder's own smoke-test artifacts; `manifest.json`, both licence files, the loader and the payload are vendored, with the payload gzipped because it exceeds the 512 KB threshold.

Then:

1. Update `PYTHON_BUNDLES` in [src/lib/pythonRunner.ts](../../src/lib/pythonRunner.ts) — one entry per line, `version` the label to show and `directory` the bundle folder.
2. Move `DEFAULT_PYTHON_VERSION` to the release you want the selector to open on. It is also `REQUIRED_PYTHON_VERSIONS`, the version the UI warns about when the deployment does not carry it.
3. When a release supersedes its own pre-release, replace the old entry rather than adding a second one — two labels for one line makes the selector confusing, and the vendored bytes are what ships.
4. Run `npm test`; `src/test/pythonBundles.test.ts` checks every declared bundle exists and that the gzipped payload still decompresses to the hash recorded at build time, so a mistaken `--to` or a corrupt copy fails there rather than in the editor.
5. Run the `python` e2e spec, which asserts the default label and real interpreter output.
