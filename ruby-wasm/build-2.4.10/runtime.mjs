import createRuby from './legacy.mjs';

export async function runCommand(bytes, output, source, stdin = '') {
  const input = new TextEncoder().encode(stdin);
  let cursor = 0;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const pending = { stdout: '', stderr: '' };
  const flush = name => { if (pending[name]) output(name, pending[name]); pending[name] = ''; };
  const byte = name => value => {
    if (value !== null) {
      const text = decoders[name].decode(new Uint8Array([value]), { stream: true });
      pending[name] += text;
      if (value === 10 || pending[name].length >= 512) flush(name);
    }
  };
  const ruby = await createRuby({
    wasmBinary: bytes,
    noInitialRun: true,
    printErr: text => output('stderr', text + '\n'),
    preRun: [module => module.FS.init(() => cursor < input.length ? input[cursor++] : null, byte('stdout'), byte('stderr'))],
  });
  let code;
  const program = '$stdout.sync = 1; $stderr.sync = 1;\n' + source;
  try {
    if (ruby.getExitStatus) {
      const returned = await ruby.ccall('ruby_wasm_run', 'number', ['string'], [program], { async: true });
      code = typeof returned === 'number' ? returned : ruby.getExitStatus();
    } else code = ruby.callMain(['-I/usr/local/lib/ruby', '-e', program]);
  } catch (error) {
    if (typeof error.status === 'number') code = error.status;
    else throw error;
  } finally {
    for (const name of ['stdout', 'stderr']) {
      const tail = decoders[name].decode();
      pending[name] += tail;
      flush(name);
    }
  }
  if (code !== 0) throw new Error(`Ruby exited with status ${code}`);
}
