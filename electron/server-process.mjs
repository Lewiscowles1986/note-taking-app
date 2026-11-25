// Runs inside Electron's utility process (utilityProcess.fork), or standalone
// under plain Node via scripts/electron-serve.mjs — which is how the server is
// verified without a GUI.
import path from 'node:path';
import { createApp, hostGuard, staticAssets, listen } from './server.mjs';

const root = process.env.NOTE_HAVEN_ROOT;
const host = process.env.NOTE_HAVEN_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.NOTE_HAVEN_PORT ?? '4173', 10);

const parentPort = process.parentPort ?? null;

async function main() {
  if (!root) throw new Error('NOTE_HAVEN_ROOT is not set');
  const app = createApp({
    middlewares: [hostGuard([`${host}:${port}`]), staticAssets(path.resolve(root))],
  });
  await listen(app, { host, port });
  console.log(`[electron-server] http://${host}:${port}/  root=${path.resolve(root)}`);
  parentPort?.postMessage({ type: 'ready', port });
}

main().catch((error) => {
  parentPort?.postMessage({ type: 'error', code: error.code ?? null, message: error.message });
  console.error('[electron-server] fatal:', error.message);
  process.exit(1);
});
