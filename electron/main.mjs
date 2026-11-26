// Electron entry point. The renderer is served over loopback HTTP so it gets a
// real web origin: IndexedDB, localStorage, fetch, DecompressionStream and
// crypto.subtle all behave exactly as in a browser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell, utilityProcess } from 'electron';
import { createShutdownTracker, createServerExitHandler, createRestartPolicy } from './lifecycle.mjs';
import { resolveRendererRoot } from './paths.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

// The port is part of the app's identity: IndexedDB — every note — is keyed by
// origin. It is fixed rather than assigned, and a collision is fatal; falling
// back to another port would present the user with a silently empty note store.
// 4173 matches the seeded OIDC redirect URI in server/seed.mjs.
const PORT = Number.parseInt(process.env.NOTE_HAVEN_PORT ?? '4173', 10);

// Set by `npm run electron:dev`: use the Vite dev server and skip the built
// assets entirely, so HMR works. Dev therefore has its own origin and its own
// (empty) note store.
const devUrl = process.env.NOTE_HAVEN_DEV_URL;

const rendererRoot = resolveRendererRoot({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  moduleDir,
});

let serverProcess = null;
const shutdown = createShutdownTracker();
const restartPolicy = createRestartPolicy();
let serverStartedAt = 0;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(moduleDir, 'server-process.mjs'), [], {
      env: {
        ...process.env,
        NOTE_HAVEN_ROOT: rendererRoot,
        NOTE_HAVEN_HOST: HOST,
        NOTE_HAVEN_PORT: String(PORT),
        // Lets the child notice a Force Quit and release the port.
        NOTE_HAVEN_PARENT_PID: String(process.pid),
      },
      stdio: 'inherit',
    });

    const timer = setTimeout(() => reject(new Error('the embedded server did not start within 15s')), 15_000);

    child.once('message', (message) => {
      clearTimeout(timer);
      if (message?.type === 'ready') return resolve(child);
      reject(new Error(message?.message ?? 'the embedded server failed to start'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the embedded server exited with code ${code}`));
    });
  });
}

async function launchServer() {
  serverProcess = await startServer();
  serverStartedAt = Date.now();

  const handleExit = createServerExitHandler({
    tracker: shutdown,
    port: PORT,
    showErrorBox: dialog.showErrorBox,
    quit: () => app.quit(),
    restart: () => void scheduleRestart(),
  });

  serverProcess.once('exit', (code) => {
    serverProcess = null;
    restartPolicy.recordHealthyUptime(Date.now() - serverStartedAt);
    handleExit(code);
  });
}

async function scheduleRestart() {
  const delay = restartPolicy.nextDelay();
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (shutdown.isShuttingDown()) return;

  try {
    await launchServer();
  } catch (error) {
    // Keep the port invariant: retry the same port rather than giving up or
    // moving to another one.
    console.error('[main] server restart failed:', error.message);
    void scheduleRestart();
    return;
  }

  for (const window of BrowserWindow.getAllWindows()) window.reload();
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#F5F1E8',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const origin = new URL(url).origin;

  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  void window.loadURL(url);
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    const url = devUrl ?? `http://${HOST}:${PORT}/`;

    if (!devUrl) {
      try {
        await launchServer();
      } catch (error) {
        dialog.showErrorBox(
          'Note Haven could not start',
          [
            error.message,
            '',
            `The app needs http://${HOST}:${PORT}/ as its origin, because notes are`,
            'stored against that origin. Quit whatever is using the port and try again.',
          ].join('\n'),
        );
        app.quit();
        return;
      }
    }

    createWindow(url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Record the intent before killing: the child's exit event follows, and it
  // must not be mistaken for a crash.
  shutdown.begin();
  serverProcess?.kill();
  serverProcess = null;
});
