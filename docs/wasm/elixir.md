# Run Elixir in your notes

Elixir code blocks run in the browser through a vendored Elixir/BEAM WebAssembly build. Press **Run** under the block; the result appears below the code, with the evaluated value echoed as `=> ...`.

```elixir
greeting = "Hello from " <> System.version()
IO.puts(greeting)
Enum.sum(1..10)
```

## Pin a version

A version selector next to **Run** lists every build that is present, labelled with the Elixir version.

```elixir
version: 1.20.4
---
IO.puts(System.version())
```

## Cross-origin isolation is required

The BEAM build is threaded: it uses shared memory and spawns pthread workers, so it only starts in a **cross-origin isolated** context. The host must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `self.crossOriginIsolated` is false and the VM aborts with "worker sent an error". The bundled dev server and `vite preview` send both headers, and so does the sibling lab's `serve.py`. **GitHub Pages cannot send custom headers**, so Elixir blocks do not run on a Pages deployment — only where you control the headers (local dev, the dev container, or any reverse proxy you own).

```elixir
# Confirm the host sends the headers; this raises in a non-isolated context.
unless :erlang.system_info(:check_io) do
  IO.puts("io ok")
end
```

## How it runs

`src/lib/elixir.worker.ts` fetches the vendored bundle, expands `filesystem.tar.gz` into the in-memory filesystem, and runs the bundled `lab_runner` module against your source. The VM starts fresh for every Run, so state does not carry between blocks; the filesystem is ephemeral.

The bundle is built by the separate [elixir-wasm-builder](https://github.com/lewiscowles-netizen/elixir-wasm-builder) repository and vendored into `public/elixir-wasm/`. It is fetched on demand, so nothing loads until an Elixir block runs.
