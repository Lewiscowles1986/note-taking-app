# Electron target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off Electron build target that ships the app inside the binary and serves it from a fixed-origin loopback HTTP server, leaving the web build untouched.

**Architecture:** `electron/main.mjs` forks `electron/server-process.mjs` with `utilityProcess.fork()`; the child runs a middleware pipeline (`electron/server.mjs`) whose only shipped middleware is `staticAssets(root)`. The renderer loads `http://127.0.0.1:4173/`, so IndexedDB, `fetch`, `DecompressionStream` and `crypto.subtle` behave exactly as on the web. `VITE_ELECTRON=1` makes Vite skip the PWA plugin and emit `dist-electron/`.

**Tech Stack:** Electron 45 (ESM, `utilityProcess`), Node `node:test` + `node:assert/strict` (the convention already used in `server/test/`), Vite 5.

**Design doc:** [2026-11-25-electron-fork-design.md](./2026-11-25-electron-fork-design.md)

---

## Preconditions

- Work in the worktree `.worktrees/electron-fork` on branch `feat/electron-fork`.
- Never commit to `main`.
- `node_modules/` is **not** installed in the worktree. Run `npm install` once before Task 2.
- Tests use Node's built-in runner (no new test dependency). `npm run test` (Vitest) only globs `src/**`, so the two suites never collide.
- Test counts in this plan were confirmed by running the plan's own code from a scratch directory. Four of the socket-free tests (`createApp` ordering, 404, 500-masking, `status` passthrough) and both `paths.mjs` tests were executed and passed; the socket-backed tests could not run there because the sandbox refuses `listen()` with `EPERM`. Run `npm run test:electron` in a normal shell or CI to exercise those.

## File map

| File | Responsibility |
|---|---|
| `electron/server.mjs` | `createApp`, `hostGuard`, `staticAssets`, `contentTypeFor`, `listen` — no Electron import, fully testable in plain Node |
| `electron/server-process.mjs` | Utility-process entry: reads env, builds the middleware chain, posts `ready` to the parent |
| `electron/paths.mjs` | `resolveRendererRoot()` — asar-aware location of the built renderer |
| `electron/main.mjs` | App lifecycle, single-instance lock, window, navigation guards, child supervision |
| `electron/test/helpers.mjs` | `fakeRes()`, `withServer()`, `fixtureDir()`, `rawRequest()` |
| `electron/test/server.test.mjs` | Pipeline, MIME, `.gz`, `Host`, traversal, SPA fallback |
| `electron/test/paths.test.mjs` | Packaged vs unpackaged root resolution |
| `scripts/electron-serve.mjs` | Runs the server standalone against `dist-electron/` (verification without a GUI) |
| `docs/technical/electron.md` | User/developer documentation for the target |
| `vite.config.ts` | `VITE_ELECTRON` flag: skip PWA, `outDir: dist-electron` |
| `package.json` | `main`, `electron` devDependency, `build:electron` / `electron:start` / `electron:dev` / `electron:serve` / `test:electron` |
| `.github/workflows/ci.yml` | Trigger paths, `test:electron`, `ELECTRON_SKIP_BINARY_DOWNLOAD` |

---

### Task 1: Dependencies, scripts, ignore rules

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `docs/plans/2026-11-25-electron-fork-design.md`

- [ ] **Step 1: Add the Electron devDependency**

```bash
npm install --save-dev electron@^45.5.0
```

Expected: `package.json` gains `"electron": "^45.5.0"` under `devDependencies` and `package-lock.json` changes. This downloads a ~100 MB binary; that is expected once.

- [ ] **Step 2: Add the `main` entry and scripts**

In `package.json`, add `"main": "electron/main.mjs"` immediately after `"type": "module"`, and add these scripts after `"build:nosync"`:

```json
    "build:electron": "VITE_ELECTRON=1 vite build --outDir dist-electron --emptyOutDir",
    "electron:serve": "NOTE_HAVEN_ROOT=dist-electron node scripts/electron-serve.mjs",
    "electron:start": "electron .",
    "electron:dev": "NOTE_HAVEN_DEV_URL=http://localhost:8080 electron .",
    "test:electron": "node --test \"electron/test/*.test.mjs\"",
```

- [ ] **Step 3: Ignore the Electron build output**

In `.gitignore`, after the existing `dist-ssr` line, add:

```
dist-electron
```

- [ ] **Step 4: Align the design doc's file list**

The design lists three files; the plan adds a fourth (`server-process.mjs`) so `server.mjs` stays importable without side effects. In `docs/plans/2026-11-25-electron-fork-design.md`, replace the architecture code block with:

```
electron/main.mjs             app lifecycle, single-instance lock, window, navigation guards
electron/server.mjs           createApp({ middlewares }) + staticAssets(root); no Electron import
electron/server-process.mjs   utility-process entry: env → chain → { type: "ready", port }
electron/paths.mjs            asar-aware resolution of the built renderer root
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore docs/plans/2026-11-25-electron-fork-design.md
git commit -m "chore(electron): add electron devDependency and target scripts"
```

---

### Task 2: The middleware pipeline

**Files:**
- Create: `electron/server.mjs`
- Create: `electron/test/helpers.mjs`
- Test: `electron/test/server.test.mjs`

- [ ] **Step 1: Write the test helpers**

Create `electron/test/helpers.mjs`:

```js
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
```

- [ ] **Step 2: Write the failing test**

Create `electron/test/server.test.mjs`:

```js
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { fakeRes } from './helpers.mjs';

describe('createApp', () => {
  it('runs middlewares in order and stops at the first that answers', async () => {
    const calls = [];
    const app = createApp({
      middlewares: [
        (req, res, next) => { calls.push('a'); return next(); },
        (req, res) => { calls.push('b'); res.writeHead(200); res.end('ok'); },
        (req, res, next) => { calls.push('c'); return next(); },
      ],
    });
    const res = fakeRes();
    await app({ method: 'GET', url: '/', headers: {} }, res);

    assert.deepEqual(calls, ['a', 'b']);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'ok');
  });

  it('answers 404 when no middleware handles the request', async () => {
    const app = createApp({ middlewares: [(req, res, next) => next()] });
    const res = fakeRes();
    await app({ method: 'GET', url: '/nope', headers: {} }, res);

    assert.equal(res.statusCode, 404);
  });

  it('turns a thrown error into a 500 without leaking the message', async () => {
    const app = createApp({ middlewares: [() => { throw new Error('boom-secret'); }] });
    const res = fakeRes();
    const originalError = console.error;
    console.error = () => {};
    try {
      await app({ method: 'GET', url: '/', headers: {} }, res);
    } finally {
      console.error = originalError;
    }

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.includes('boom-secret'), false);
  });

  it('honours an error with a status property', async () => {
    const app = createApp({
      middlewares: [() => { throw Object.assign(new Error('teapot'), { status: 418 }); }],
    });
    const res = fakeRes();
    await app({ method: 'GET', url: '/', headers: {} }, res);

    assert.equal(res.statusCode, 418);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: FAIL — `Cannot find module '../server.mjs'`.

- [ ] **Step 4: Write the minimal implementation**

Create `electron/server.mjs`:

```js
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
```

- [ ] **Step 5: Run tests until green**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/server.mjs electron/test
git commit -m "feat(electron): add a middleware pipeline with no static assumptions"
```

---

### Task 3: Serve files with correct MIME types

**Files:**
- Modify: `electron/server.mjs`
- Test: `electron/test/server.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `electron/test/server.test.mjs` (and extend the imports to `withServer, fixtureDir`):

```js
describe('staticAssets', () => {
  const root = fixtureDir({
    'index.html': '<!doctype html><title>app</title>',
    'assets/app.js': 'console.log(1);',
    'assets/app.mjs': 'export default 1;',
    'assets/app.css': 'body{}',
    'manifest.webmanifest': '{"name":"x"}',
    'php-wasm/build-8.4.x/php-web.mjs': 'export default 1;',
    'php-wasm/build-8.4.x/php-web.wasm': Buffer.from([0, 97, 115, 109]),
    'notes/data.json': '{"a":1}',
  });

  it('serves files with the MIME type their loader requires', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (base) => {
      const cases = [
        ['/assets/app.mjs', 'text/javascript; charset=utf-8'],
        ['/php-wasm/build-8.4.x/php-web.wasm', 'application/wasm'],
        ['/notes/data.json', 'application/json; charset=utf-8'],
        ['/assets/app.css', 'text/css; charset=utf-8'],
        ['/manifest.webmanifest', 'application/manifest+json'],
        ['/', 'text/html; charset=utf-8'],
      ];
      for (const [path, expected] of cases) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers.get('content-type'), expected, path);
      }
    });
  });

  it('answers HEAD with headers and an empty body', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '');
      assert.equal(res.headers.get('content-length'), String('console.log(1);'.length));
    });
  });
});
```

Also update the import line at the top of the file to:

```js
import { createApp, staticAssets } from '../server.mjs';
import { fakeRes, withServer, fixtureDir } from './helpers.mjs';
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: FAIL — `staticAssets` is not exported.

- [ ] **Step 3: Implement MIME mapping and file serving**

Append to `electron/server.mjs` (and add `import path from 'node:path';`, `import { createReadStream } from 'node:fs';`, `import { stat } from 'node:fs/promises';` to the imports):

```js
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
```

Note: `createApp` returns a promise, so `await app(...)` works in tests and the real `http.Server` ignores the return value.

- [ ] **Step 4: Run tests**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/server.mjs electron/test/server.test.mjs
git commit -m "feat(electron): serve built assets with loader-correct MIME types"
```

---

### Task 4: Gzipped wasm bundles must stay opaque

**Files:**
- Test: `electron/test/server.test.mjs`

This is the trap that would silently break every code runner: the bundles are committed gzipped and decompressed in JS by `src/lib/wasmAssets.ts`. A response with `Content-Encoding: gzip` gets decompressed again by the browser.

- [ ] **Step 1: Write the failing test**

Append to `electron/test/server.test.mjs`:

```js
describe('gzipped vendored assets', () => {
  const root = fixtureDir({
    'index.html': '<!doctype html>',
    // The sentinel marks the stored bytes; if the server claimed gzip encoding
    // at the HTTP layer, fetch() would transparently inflate them and the
    // marker would not survive.
    'ruby-wasm/build-3.4.1/ruby.wasm.gz': Buffer.from('NOT-ACTUALLY-GZIP-BYTES'),
  });

  it('sends .gz bytes verbatim without Content-Encoding', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/ruby-wasm/build-3.4.1/ruby.wasm.gz`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-encoding'), null);
      assert.equal(await res.text(), 'NOT-ACTUALLY-GZIP-BYTES');
    });
  });
});
```

- [ ] **Step 2: Run it**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: PASS — `sendFile` never sets `Content-Encoding` and `.gz` maps to `application/octet-stream` (Task 3). If it fails, the implementation is wrong, not the test.

- [ ] **Step 3: Commit**

```bash
git add electron/test/server.test.mjs
git commit -m "test(electron): pin that .gz assets are never content-encoded"
```

---

### Task 5: Host validation and traversal rejection

**Files:**
- Modify: `electron/server.mjs`
- Test: `electron/test/server.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `electron/test/server.test.mjs` (extend the import to include `hostGuard`, and `rawRequest` from helpers):

```js
describe('hostGuard', () => {
  it('rejects a Host it was not built for (DNS rebinding)', async () => {
    // fetch() forbids overriding Host, hence raw http in rawRequest().
    const app = createApp({ middlewares: [hostGuard(['127.0.0.1:4173'])] });
    await withServer(app, async (_base, port) => {
      // The guard-only chain has no static middleware, so an allowed Host
      // falls through to createApp's terminal 404. What matters is 421 vs not.
      const ok = await rawRequest({ port, host: '127.0.0.1:4173' });
      assert.equal(ok.status, 404);
      const bad = await rawRequest({ port, host: 'attacker.example' });
      assert.equal(bad.status, 421);
    });
  });
});

describe('traversal', () => {
  const root = fixtureDir({
    'index.html': '<!doctype html>',
    'public.txt': 'inside',
  });

  it('never serves a file outside the root', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (_base, port) => {
      // rawRequest, not fetch: fetch() normalises `/../x` client-side, which
      // would hide exactly the input being tested.
      for (const attempt of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json']) {
        const res = await rawRequest({ port, path: attempt, host: `127.0.0.1:${port}` });
        assert.equal(res.status, 404, attempt);
        assert.equal(res.body.includes('"name":'), false, attempt);
      }
      const inside = await fetch(`http://127.0.0.1:${port}/public.txt`);
      assert.equal(await inside.text(), 'inside');
    });
  });
});
```

Note: this chain has no `hostGuard`, so `rawRequest` must send a Host the server accepts — but nothing validates Host here, so any value works. Send `127.0.0.1:${port}` regardless, to keep the test honest if a guard is added later.

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: FAIL — `hostGuard` is not exported; traversal subtest fails because `..` resolves outside `root` and `stat` finds `package.json`.

- [ ] **Step 3: Implement the guard and harden resolution**

Append to `electron/server.mjs`:

```js
/**
 * Reject requests whose Host header is not the loopback name the app was
 * built for. Without this, a web page can point a hostname at 127.0.0.1 and
 * reach this server (DNS rebinding).
 */
export function hostGuard(allowedHosts) {
  const allowed = new Set([...allowedHosts].map((host) => host.toLowerCase()));
  return function guard(req, res, next) {
    const host = typeof req.headers?.host === 'string' ? req.headers.host.toLowerCase() : '';
    if (!allowed.has(host)) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('Misdirected Request\n');
      return;
    }
    return next();
  };
}
```

`resolveWithin` already returns `null` for a candidate outside the root; the traversal test therefore 404s via `next()` → `createApp`'s terminal 404. Verify the encoded variants: `new URL('/..%2fpackage.json', ...)` keeps the escape encoded until `decodeURIComponent`, which yields `/../package.json` → `path.resolve` escapes → `null`. Confirm by reading the test output; if a variant still returns 200, add the guard `if (pathname.includes('\0')) return next();` and reject any pathname whose decoded form contains a `..` segment before resolving.

- [ ] **Step 4: Run tests**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/server.mjs electron/test/server.test.mjs
git commit -m "feat(electron): reject foreign Host headers and root escapes"
```

---

### Task 6: SPA fallback for client-side routes

**Files:**
- Modify: `electron/server.mjs`
- Test: `electron/test/server.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `electron/test/server.test.mjs`:

```js
describe('SPA fallback', () => {
  const root = fixtureDir({
    'index.html': '<!doctype html><div id="root"></div>',
    'assets/app.js': '1;',
  });

  it('serves index.html for an extensionless client route', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/auth/callback`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /<div id="root">/);
    });
  });

  it('does NOT fall back for a missing file with an extension', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/assets/missing.js`);
      assert.equal(res.status, 404);
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: FAIL — `/auth/callback` 404s.

- [ ] **Step 3: Implement the fallback**

In `electron/server.mjs`, replace the file-serving tail of `serveStatic` with:

```js
    const served = await sendFile(req, res, target);
    if (served) return;
    // A client-side route: an extensionless path with no file behind it.
    // Everything else (e.g. a missing /assets/x.js) stays a real 404.
    if (!path.extname(pathname)) return sendFile(req, res, path.join(rootDir, 'index.html'));
    return next();
```

`sendFile` already reports whether it answered (Task 3 returns `true`/`false`), so no signature change is needed here.

- [ ] **Step 4: Run tests**

```bash
node --test "electron/test/server.test.mjs"
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/server.mjs electron/test/server.test.mjs
git commit -m "feat(electron): fall back to the app shell for client routes"
```

---

### Task 7: Resolve the renderer root

**Files:**
- Create: `electron/paths.mjs`
- Test: `electron/test/paths.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `electron/test/paths.test.mjs`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRendererRoot } from '../paths.mjs';

describe('resolveRendererRoot', () => {
  it('reads the built renderer from inside the app bundle when packaged', () => {
    const root = resolveRendererRoot({
      isPackaged: true,
      appPath: path.join('/Applications', 'Note Haven.app', 'Contents', 'Resources', 'app.asar'),
      moduleDir: '/ignored',
    });
    assert.equal(
      root,
      path.join('/Applications', 'Note Haven.app', 'Contents', 'Resources', 'app.asar', 'dist-electron'),
    );
  });

  it('reads the worktree build when running from source', () => {
    const root = resolveRendererRoot({
      isPackaged: false,
      appPath: '/ignored',
      moduleDir: '/repo/electron',
    });
    assert.equal(root, path.resolve('/repo', 'dist-electron'));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node --test "electron/test/paths.test.mjs"
```

Expected: FAIL — `Cannot find module '../paths.mjs'`.

- [ ] **Step 3: Implement**

Create `electron/paths.mjs`:

```js
import path from 'node:path';

/**
 * Where the built renderer lives. Packaged, it sits inside app.asar next to
 * this module; in a checkout it is the worktree's `dist-electron/`.
 * `app.asar` is readable by Electron's patched `fs`, so no unpacking needed.
 */
export function resolveRendererRoot({ isPackaged, appPath, moduleDir }) {
  return isPackaged
    ? path.join(appPath, 'dist-electron')
    : path.resolve(moduleDir, '..', 'dist-electron');
}
```

- [ ] **Step 4: Run tests**

```bash
node --test "electron/test/paths.test.mjs"
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add electron/paths.mjs electron/test/paths.test.mjs
git commit -m "feat(electron): resolve the renderer root for packaged and dev runs"
```

---

### Task 8: The utility-process entry

**Files:**
- Create: `electron/server-process.mjs`
- Create: `scripts/electron-serve.mjs`

- [ ] **Step 1: Write the entry**

Create `electron/server-process.mjs`:

```js
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
```

- [ ] **Step 2: Write the standalone runner**

Create `scripts/electron-serve.mjs`:

```js
// Serve dist-electron/ the way the packaged app does, without launching
// Electron. Handy for poking the build in a normal browser:
//
//   npm run build:electron && npm run electron:serve
import './../electron/server-process.mjs';
```

- [ ] **Step 3: Verify by hand**

```bash
npm run build:electron
npm run electron:serve
```

Expected: prints `[electron-server] http://127.0.0.1:4173/  root=...`. In another shell:

```bash
curl -sI http://127.0.0.1:4173/ | head -3
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: attacker.example' http://127.0.0.1:4173/
```

Expected: `200` with `Content-Type: text/html`, then `421`. Stop the server with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add electron/server-process.mjs scripts/electron-serve.mjs
git commit -m "feat(electron): add the utility-process server entry and a standalone runner"
```

---

### Task 9: The Electron main process

**Files:**
- Create: `electron/main.mjs`

- [ ] **Step 1: Implement**

Create `electron/main.mjs`:

```js
// Electron entry point. The renderer is served over loopback HTTP so it gets a
// real web origin: IndexedDB, localStorage, fetch, DecompressionStream and
// crypto.subtle all behave exactly as in a browser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell, utilityProcess } from 'electron';
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

function startServer() {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(moduleDir, 'server-process.mjs'), [], {
      env: {
        ...process.env,
        NOTE_HAVEN_ROOT: rendererRoot,
        NOTE_HAVEN_HOST: HOST,
        NOTE_HAVEN_PORT: String(PORT),
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
        serverProcess = await startServer();
        serverProcess.once('exit', (code) => {
          serverProcess = null;
          dialog.showErrorBox(
            'Note Haven stopped',
            `The embedded server exited (code ${code}). Port ${PORT} may be in use by another process.`,
          );
          app.quit();
        });
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
  serverProcess?.kill();
  serverProcess = null;
});
```

- [ ] **Step 2: Smoke it**

```bash
npm run build:electron
npm run electron:start
```

Expected: a window opens showing Note Haven at `http://127.0.0.1:4173/`, no blank page, no console dialog. Create a note, quit, relaunch — the note is still there.

If it opens blank, check the terminal for `[electron-server]` output and confirm `dist-electron/index.html` exists.

- [ ] **Step 3: Commit**

```bash
git add electron/main.mjs
git commit -m "feat(electron): add the app shell with a fixed-origin server"
```

---

### Task 10: The Vite flag

**Files:**
- Modify: `vite.config.ts`

- [ ] **Step 1: Add the flag**

In `vite.config.ts`, next to the `noSyncBuild` declaration:

```ts
// VITE_ELECTRON=1 builds the Electron target: no service worker (a desktop app
// has no origin to refresh from, and a stale profile worker after an upgrade is
// a real bug) and its own output directory, so the web build is untouched.
const electronBuild = process.env.VITE_ELECTRON === "1";
```

- [ ] **Step 2: Make the PWA plugin conditional**

Replace the `VitePWA({ ... })` entry in the `plugins` array with a conditional spread. The array becomes:

```ts
  plugins: [
    react(),
    excludeDisabledLanguages(enabledLanguages),
    { name: "compose-social-preview-url", transformIndexHtml: (html) => html.replaceAll("__ASSET_BASE_URL__", assetBaseUrl) },
    ...(electronBuild ? [] : [VitePWA({ /* existing options unchanged */ })]),
  ],
```

- [ ] **Step 3: Add the output directory**

Add a `build` block to the exported config, after `define`:

```ts
  build: {
    outDir: electronBuild ? "dist-electron" : "dist",
  },
```

- [ ] **Step 4: Verify both targets**

```bash
npm run build:electron && ls dist-electron
npm run build && ls dist | grep -E '^(sw\.js|workbox-.*\.js)$'
npm run build:electron && ls dist-electron | grep -c 'sw.js' || true
```

Expected: web build still emits `sw.js` and `workbox-*.js`; `dist-electron` contains none. `dist/` still exists and is unchanged in shape.

- [ ] **Step 5: Verify the language flag composes**

```bash
VITE_LANGUAGES=php npm run build:electron
ls dist-electron | grep -- '-wasm'
```

Expected: only `php-wasm`. This is the slim / PHP-only desktop build.

- [ ] **Step 6: Commit**

```bash
git add vite.config.ts
git commit -m "feat(build): add a VITE_ELECTRON target that skips the service worker"
```

---

### Task 11: CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add trigger paths**

Add `- "electron/**"` to both `paths` lists (push and pull_request).

- [ ] **Step 2: Skip the Electron binary download**

Add a workflow-level `env:` block after the `name:` line:

```yaml
env:
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1"
```

CI never launches Electron — it only runs the Node-level server tests and the Vite build — so downloading the ~100 MB binary on every matrix entry is pure cost.

- [ ] **Step 3: Run the new suite**

In the `test` job, after `npm run test`, add:

```yaml
      - name: Run Electron server tests
        run: npm run test:electron
```

- [ ] **Step 4: Verify locally**

```bash
npm run test:electron
npm run build:electron
npm run lint
```

Expected: 13 tests pass, build succeeds, lint clean. If oxlint complains about Node globals in `electron/**`, add `"electron"` to the `ignorePatterns` array in `.oxlintrc.json` — `server/` is linted today, so this should not be needed.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the Electron server tests and skip the Electron binary"
```

---

### Task 12: Documentation

**Files:**
- Create: `docs/technical/electron.md`
- Modify: `README.md`

- [ ] **Step 1: Write the doc**

Create `docs/technical/electron.md` covering, in this order:

1. **What this target is** — the app ships as installed bytes; nothing is fetched at run time. Web remains the default target and is unchanged.
2. **Commands** — `build:electron`, `electron:start`, `electron:dev` (with `npm run dev` in a second terminal), `electron:serve` + a browser tab, `test:electron`.
3. **The origin rule** — fixed port 4173, why (IndexedDB is origin-keyed), what a collision looks like, `NOTE_HAVEN_PORT`.
4. **Your notes are not shared with the browser** — Electron has its own `userData` profile; first run is empty; move notes with Export → Import.
5. **Choosing the wasm payload** — `VITE_LANGUAGES=php npm run build:electron`, default `js,php,python,ruby`.
6. **Sync** — on by default; `VITE_NO_SYNC=1 VITE_ELECTRON=1 npm run build:electron` for a strictly local build. Note the in-app sync server is a [future seam](./../plans/2026-11-25-electron-fork-design.md) with two known blockers (unconditional dev-user seeding, pinned `redirect_uris`).
7. **Not done yet** — installers, signing, auto-update.

- [ ] **Step 2: Link it from the README**

In the README's **Getting Started → Build** step, add after `npm run build`:

```markdown
   To build the desktop target (see [docs/technical/electron.md](docs/technical/electron.md)):

   ```bash
   npm run build:electron && npm run electron:start
   ```
```

- [ ] **Step 3: Final verification**

```bash
npm run test          # unchanged web suite still green
npm run test:electron # 13 server/paths tests
npm run lint
npm run build         # web target unchanged
npm run build:electron
git status --short    # only intended files
```

- [ ] **Step 4: Commit and push**

```bash
git add docs/technical/electron.md README.md
git commit -m "docs: document the Electron target"
git push -u origin feat/electron-fork
```

---

## Self-review checklist

- [ ] `VITE_ELECTRON` unset ⇒ byte-identical web behaviour (`build`, `build:nosync`, PWA, language pruning).
- [ ] No file under `src/` changes. If one must, stop: the design says web is untouched.
- [ ] `electron/**` imports nothing from `electron` except `main.mjs` (keeps `server.mjs` testable in plain Node).
- [ ] `.gz` is never served with `Content-Encoding` (Task 4 test is the guard).
- [ ] Port collision produces a dialog that names the port, never a silent fallback.
- [ ] `npm run test:electron` passes with no network access.
