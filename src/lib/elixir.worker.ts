/// <reference lib="webworker" />
/**
 * Elixir BEAM worker.
 *
 * The BEAM wasm build is threaded (it transfers SharedArrayBuffers and spawns
 * pthreads), which only works off the main thread, so the VM runs here and the
 * runner talks to it over postMessage. Mirrors the proven elixir-wasm-lab
 * worker: fetch the bundle, expand the filesystem archive into MEMFS, then run
 * the bundled `lab_runner` module against /main.exs.
 */

import { loadAsset, loadVendorManifest } from './wasmAssets';

interface FsLikeModule {
  ENV?: Record<string, string>;
  FS_mkdirTree(path: string): void;
  FS_createDataFile(
    parent: string,
    name: string | null,
    data: Uint8Array,
    canRead: boolean,
    canWrite: boolean,
    canOwn: boolean,
  ): void;
}

const textDecoder = new TextDecoder();

function unpack(bytes: Uint8Array, module: FsLikeModule) {
  const field = (header: Uint8Array, start: number, end: number) =>
    textDecoder.decode(header.subarray(start, end)).replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = [field(header, 345, 500), field(header, 0, 100)].filter(Boolean).join('/');
    const size = parseInt(field(header, 124, 136).trim(), 8) || 0;
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Unsafe archive path');
    if (![0, 48].includes(header[156])) throw new Error(`Unsupported archive entry: ${name}`);
    const path = `/${name}`;
    module.FS_mkdirTree(path.slice(0, path.lastIndexOf('/')) || '/');
    module.FS_createDataFile(path, null, bytes.slice(offset + 512, offset + 512 + size), true, true, true);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { base, directory, code } = event.data as { base: string; directory: string; code: string };
  const dir = `${base}elixir-wasm/build-${directory}/`;
  try {
    const manifest = await loadVendorManifest(dir);
    const filesystem = await loadAsset(dir, 'filesystem.tar.gz', manifest);
    const meta = (await (await fetch(`${dir}manifest.json`)).json()) as { codePaths?: string[] };
    const codePaths = meta.codePaths ?? [];

    const imported = (await import(/* @vite-ignore */ `${dir}beam.mjs`)) as {
      default: (options: Record<string, unknown>) => Promise<unknown>;
    };

    const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    const post = (stream: 'stdout' | 'stderr', text: string) => {
      if (text) self.postMessage({ type: 'output', stream, text });
    };
    let aborted: string | null = null;

    await imported.default({
      // beam.wasm is vendored uncompressed so Emscripten (and its pthread
      // workers, which fetch the wasm independently) can load it by name.
      locateFile: (file: string) => `${dir}${file}`,
      print: (text: string) => post('stdout', `${text}\n`),
      printErr: (text: string) => post('stderr', `${text}\n`),
      onTtyChunk: (fd: number, chunk: Uint8Array) =>
        post(fd === 1 ? 'stdout' : 'stderr', decoders[fd === 1 ? 1 : 2].decode(chunk, { stream: true })),
      onAbort: (reason: unknown) => { aborted = String(reason); },
      onError: (reason: unknown) => { aborted = String(reason); },
      onExit: (status: number) => {
        for (const fd of [1, 2] as const) post(fd === 1 ? 'stdout' : 'stderr', decoders[fd].decode());
        self.postMessage({ type: 'exit', status, aborted });
      },
      arguments: [
        '-S', '1:1', '-SDcpu', '1', '-SDio', '1', '--',
        '-root', '/', '-bindir', '/bin', '-progname', 'erl', '-home', '/home/web_user',
        '-boot', '/bin/vm', '-kernel', 'start_distribution', 'false', '-noshell',
        ...codePaths.flatMap((path) => ['-pa', path]),
        '-s', 'lab_runner', 'start',
      ],
      preRun: [
        (module: FsLikeModule) => {
          if (module.ENV) {
            Object.assign(module.ENV, {
              BINDIR: '/bin', EMU: 'beam', HOME: '/home/web_user',
              USER: 'web_user', LOGNAME: 'web_user', ERL_INETRC: '/etc/inetrc',
            });
          }
          unpack(filesystem, module);
          module.FS_mkdirTree('/tmp');
          module.FS_mkdirTree('/home/web_user');
          module.FS_createDataFile('/main.exs', null, new TextEncoder().encode(code), true, true, true);
        },
      ],
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.stack ?? err) });
  }
};
