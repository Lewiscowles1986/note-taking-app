// The Electron target's embedded HTTP server.
//
// A middleware pipeline, not a static file server: `staticAssets(root)` is
// merely the one middleware this build ships today. Because the chain is the
// API, a later build can compose the sync router (server/routes.mjs) onto the
// same listener and share the app's origin. Nothing here imports Electron, so
// the whole module is testable in plain Node.
import http from 'node:http';

/**
 * @typedef {(req: import('node:http').IncomingMessage,
 *            res: import('node:http').ServerResponse,
 *            next: () => Promise<void>) => unknown} Middleware
 */

export function createApp({ middlewares = [] } = {}) {
  return function handle(req, res) {
    return dispatch(req, res, middlewares, 0).catch((error) => fail(res, error));
  };
}

async function dispatch(req, res, middlewares, index) {
  if (index >= middlewares.length) return notFound(res);

  let advanced = false;
  const next = () => {
    advanced = true;
    return dispatch(req, res, middlewares, index + 1);
  };

  await middlewares[index](req, res, next);
  if (!advanced && !res.writableEnded && !res.headersSent) return notFound(res);
}

function notFound(res) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
}

function fail(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status === 500) console.error('[electron-server]', error);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(status === 500 ? 'Internal Server Error\n' : `${error.message}\n`);
}

export async function listen(app, { host, port }) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
