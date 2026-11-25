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
