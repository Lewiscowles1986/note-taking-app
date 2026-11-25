import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, staticAssets } from '../server.mjs';
import { fakeRes, withServer, fixtureDir } from './helpers.mjs';

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
    'php-wasm/build-8.4.25/php-web.mjs': 'export default 1;',
    'php-wasm/build-8.4.25/php-web.wasm': Buffer.from([0, 97, 115, 109]),
    'notes/data.json': '{"a":1}',
  });

  it('serves files with the MIME type their loader requires', async () => {
    const app = createApp({ middlewares: [staticAssets(root)] });
    await withServer(app, async (base) => {
      const cases = [
        ['/assets/app.mjs', 'text/javascript; charset=utf-8'],
        ['/php-wasm/build-8.4.25/php-web.wasm', 'application/wasm'],
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
