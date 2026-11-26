import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverProcessPath = path.join(electronDir, 'server-process.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function rendererRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'notehaven-root-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>ok</title>');
  return dir;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(500, () => request.destroy());
  });
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function startServer(env) {
  const child = spawn(process.execPath, [serverProcessPath], {
    env: { ...process.env, NOTE_HAVEN_ROOT: rendererRoot(), NOTE_HAVEN_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}

describe('server-process parent watchdog', () => {
  it('frees the port when the app that owns it is killed', async () => {
    const port = await freePort();
    // A stand-in for the Electron main process: it spawns the server and then
    // exits without any cleanup, which is what a Force Quit looks like.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        [
          'const { spawn } = require("node:child_process");',
          `const child = spawn(process.execPath, [${JSON.stringify(serverProcessPath)}], {`,
          '  env: { ...process.env, NOTE_HAVEN_PARENT_PID: String(process.pid) },',
          '  stdio: "ignore",',
          '});',
          'console.log(child.pid);',
        ].join('\n'),
      ],
      {
        env: {
          ...process.env,
          NOTE_HAVEN_ROOT: rendererRoot(),
          NOTE_HAVEN_HOST: '127.0.0.1',
          NOTE_HAVEN_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );

    try {
      assert.ok(await waitFor(() => canConnect(port)), 'server should be listening while the parent lives');

      parent.kill('SIGKILL');

      assert.ok(await waitFor(async () => !(await canConnect(port))), 'server should release the port once the parent is gone');
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('keeps serving when no parent pid is supplied', async () => {
    const port = await freePort();
    const { child } = startServer({ NOTE_HAVEN_PORT: String(port) });
    try {
      assert.ok(await waitFor(() => canConnect(port)), 'standalone serve must stay up');
      // A standalone run has no parent to lose, so it must not exit on its own.
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(child.exitCode, null);
      assert.ok(await canConnect(port));
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reports a bind failure with the real reason', async () => {
    const port = await freePort();
    const blocker = http.createServer((_req, res) => res.end('taken'));
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));

    try {
      const { child, output } = startServer({ NOTE_HAVEN_PORT: String(port) });
      const exitCode = await new Promise((resolve) => child.once('exit', resolve));
      assert.notEqual(exitCode, 0);
      assert.match(output(), /EADDRINUSE/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
