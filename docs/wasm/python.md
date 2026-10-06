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

The matrix spans Python 2.7 through 3.15 (the latest patch of each major.minor line). The default is the newest stable build, `3.14.7`.

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
