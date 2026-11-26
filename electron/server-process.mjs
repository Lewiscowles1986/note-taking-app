// Runs inside Electron's utility process (utilityProcess.fork), or standalone
// under plain Node via scripts/electron-serve.mjs — which is how the server is
// verified without a GUI.
import path from 'node:path';
import { createApp, hostGuard, staticAssets, listen } from './server.mjs';
import { watchParent } from './parent-watch.mjs';

const root = process.env.NOTE_HAVEN_ROOT;
const host = process.env.NOTE_HAVEN_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.NOTE_HAVEN_PORT ?? '4173', 10);

const parentPort = process.parentPort ?? null;

// The main process passes its own pid. Watching that explicitly is more precise
// than process.ppid, which only says who spawned us — the parent could be a
// launcher rather than the app. Absent, this is a standalone `electron:serve`
// run with nothing to outlive.
const parentPid = Number.parseInt(process.env.NOTE_HAVEN_PARENT_PID ?? '', 10);

async function main() {
  if (!root) throw new Error('NOTE_HAVEN_ROOT is not set');
  const app = createApp({
    middlewares: [hostGuard([`${host}:${port}`]), staticAssets(path.resolve(root))],
  });

  const parentDied = new Promise((resolve) => {
    if (!Number.isInteger(parentPid)) return resolve(null);
    watchParent({ pid: parentPid, onParentGone: () => resolve('parent-gone') });
  });

  const server = await listen(app, { host, port });
  console.log(`[electron-server] http://${host}:${port}/  root=${path.resolve(root)}`);
  parentPort?.postMessage({ type: 'ready', port });

  if ((await parentDied) === 'parent-gone') {
    // The app was killed without running its quit path. Close the listener so
    // the port (the note store's origin) is free for the next launch.
    console.log('[electron-server] parent process is gone; shutting down');
    server.close();
    process.exit(0);
  }
}

main().catch((error) => {
  parentPort?.postMessage({ type: 'error', code: error.code ?? null, message: error.message });
  console.error('[electron-server] fatal:', error.message);
  process.exit(1);
});
