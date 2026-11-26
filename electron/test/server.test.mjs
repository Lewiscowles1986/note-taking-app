import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, staticAssets, hostGuard } from '../server.mjs';
import { fakeRes, withServer, fixtureDir, rawRequest } from './helpers.mjs';

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
