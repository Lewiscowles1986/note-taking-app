# Run Ruby in your notes

Ruby code blocks run in the browser through a vendored CRuby WebAssembly build. Press **Run** under the block to execute it; the output appears below the code.

```ruby
puts "Hello from Ruby #{RUBY_VERSION}"
puts (1..10).sum
```

## Choose or pin a version

A version selector next to **Run** lists every build that is present, labelled with the Ruby version the bundle actually contains. A build that is missing is hidden rather than failing at run time.

Pin a version for a single block with a `version:` frontmatter line:

```ruby
version: 4.0.0
---
puts RUBY_DESCRIPTION
```

### Ruby 1.0 is a different language

The oldest line in the matrix predates a lot of today's syntax. It has no `puts`, no `RUBY_VERSION`, no `String#sum`, and no `Range#sum`, so pick a version and write to that version's rules:

```ruby
version: 1.0-971225
---
print "Ruby 1.0 in WebAssembly\n"
print Math.sqrt(144), "\n"
h = {"a" => 20, "b" => 22}
print "sum=", h["a"] + h["b"], "\n"
```

That prints `Ruby 1.0 in WebAssembly`, `12.0` and `sum=42`. From Ruby 1.9 onwards the modern example at the top of this page works unchanged.

## How the build is chosen

The selector label and the on-disk directory are not always the same. Upstream ruby.wasm baselines are keyed by line — the `4.0` directory contains Ruby `4.0.0` — so `RUBY_BUNDLES` in `src/lib/rubyRunner.ts` pairs each version with its directory. `src/test/rubyBundles.test.ts` checks that mapping and every asset hash, so a version that points at a missing or corrupt bundle fails in tests rather than in the editor.

The runner also reads each bundle's `vendor.json` to pick the loader and entry point, covering **both integration families**: modern upstream ruby.wasm exports `createVM` (a RubyVM reactor), while the historical Emscripten ports export `runCommand`.

## Size

Large binaries are committed gzipped and decompressed in the browser with `DecompressionStream`, which is about three times smaller in the repository and on the wire. Each bundle's `vendor.json` records which of its files are gzipped.

## Limits

Each run evaluates in a fresh Ruby VM under WASI Preview 1, so state does not carry between blocks, and there is no JavaScript bridge in this profile. Files live in an ephemeral in-memory filesystem. RubyGems and native extensions are not available.

The bundles are built by the separate [ruby-wasm-builder](https://github.com/lewiscowles-netizen/ruby-wasm-builder) repository and vendored into `public/ruby-wasm/`. They are loaded on demand with a dynamic `import()`, so nothing is fetched until a Ruby block actually runs.
