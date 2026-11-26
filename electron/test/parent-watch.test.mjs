import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchParent, currentParentPid } from '../parent-watch.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

describe('currentParentPid', () => {
  it('is the pid of the process that spawned this one', () => {
    assert.equal(typeof currentParentPid(), 'number');
    assert.ok(currentParentPid() > 0);
  });
});

describe('watchParent', () => {
  it('invokes the callback once the parent is gone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'notehaven-parent-watch-'));
    const childPath = path.join(dir, 'child.mjs');
    writeFileSync(
      childPath,
      [
        `import { watchParent } from ${JSON.stringify(path.resolve(moduleDir, '..', 'parent-watch.mjs'))};`,
        `watchParent({ intervalMs: 25, checkAlive: () => false, onParentGone: () => { console.log('parent-gone'); process.exit(0); } });`,
        // Keep the event loop busy so the watcher is the only thing that can end us.
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    );

    const child = spawn(process.execPath, [childPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });

    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.match(output, /parent-gone/);
    assert.equal(exitCode, 0);
  });

  it('leaves a live parent alone', async () => {
    let called = false;
    const stop = watchParent({ intervalMs: 10, checkAlive: () => true, onParentGone: () => { called = true; } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    assert.equal(called, false);
  });

  it('stops watching when the returned function is called', async () => {
    let called = false;
    const stop = watchParent({ intervalMs: 10, checkAlive: () => false, onParentGone: () => { called = true; } });
    stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(called, false);
  });
});
