# Run Ruby in your notes

Ruby code blocks run in the browser through a vendored CRuby WebAssembly build. Press **Run** under the block to execute it; the output appears below the code.

```ruby
puts "Hello from Ruby #{RUBY_VERSION}"
puts (1..10).sum
```

## Choose or pin a version

A version selector next to **Run** lists every build that is present, labelled with the real Ruby version from the bundle manifest. A build that is missing is hidden rather than failing at run time.

Pin a version for a single block with a `version:` frontmatter line:

```ruby
version: 4.0.0
---
puts RUBY_DESCRIPTION
```

## How the build is chosen

The selector label and the on-disk directory are not always the same. Upstream ruby.wasm baselines are keyed by line — the `4.0` bundle contains Ruby `4.0.0` — so `src/lib/rubyRunner.ts` maps each version to its `public/ruby-wasm/build-<directory>/`. `src/test/rubyBundles.test.ts` checks that mapping and the bundle hashes so a version that points at a missing directory fails in tests, not in the editor.

## Limits

Each run evaluates in a fresh Ruby VM under WASI Preview 1, so state does not carry between blocks, and there is no JavaScript bridge in this profile. Files live in an ephemeral in-memory filesystem. RubyGems and native extensions are not available.

The bundles are built by the separate [ruby-wasm-builder](https://github.com/lewiscowles-netizen/ruby-wasm-builder) repository and vendored into `public/ruby-wasm/`. They are loaded on demand with a dynamic `import()`, so nothing is fetched until a Ruby block actually runs.
