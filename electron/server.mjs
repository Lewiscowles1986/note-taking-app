// The Electron target's embedded HTTP server.
//
// A middleware pipeline, not a static file server: `staticAssets(root)` is
// merely the one middleware this build ships today. Because the chain is the
// API, a later build can compose the sync router (server/routes.mjs) onto the
// same listener and share the app's origin. Nothing here imports Electron, so
// the whole module is testable in plain Node.
import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

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

const JAVASCRIPT = 'text/javascript; charset=utf-8';

/** Extension → Content-Type. */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': JAVASCRIPT,
  '.mjs': JAVASCRIPT,
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/octet-stream',
});

export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function staticAssets(root) {
  const rootDir = path.resolve(root);

  return async function serveStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      return next();
    }

    const target = resolveWithin(rootDir, pathname);
    if (!target) return next();

    const served = await sendFile(req, res, target);
    return served ? undefined : next();
  };
}

/** Resolve a URL path inside `rootDir`, or null when it escapes it. */
export function resolveWithin(rootDir, pathname) {
  const relative = pathname.replace(/^\/+/, '');
  const candidate = path.resolve(rootDir, relative || 'index.html');
  const prefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (candidate !== rootDir && !candidate.startsWith(prefix)) return null;
  return candidate;
}

async function sendFile(req, res, filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(info.size),
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(filePath)
    .on('error', (error) => {
      if (!res.headersSent) return fail(res, error);
      res.destroy();
    })
    .pipe(res);
  return true;
}
