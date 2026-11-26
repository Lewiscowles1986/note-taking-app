// Shared harness for the embedded server tests: a fake response object for
// pure-middleware assertions, and real-socket helpers for file serving.
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    writeHead(code, headers = {}) {
      res.statusCode = code;
      for (const [name, value] of Object.entries(headers)) res.headers[name.toLowerCase()] = value;
      res.headersSent = true;
      return res;
    },
    end(body) {
      if (body !== undefined) res.body += String(body);
      res.headersSent = true;
      res.writableEnded = true;
    },
    destroy() {
      res.destroyed = true;
    },
  };
  return res;
}

export async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export function fixtureDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'notehaven-electron-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(dir, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

// fetch() forbids overriding Host, so the host-guard test needs raw http.
export function rawRequest({ port, path: requestPath = '/', host }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', headers: { Host: host } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
