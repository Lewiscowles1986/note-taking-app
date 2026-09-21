// Top-level request router: method+path dispatch, CORS preflight, JSON error
// fallbacks (404 with JSON, 405 with Allow header). All route handlers here
// are synchronous with the request/response objects.
import {
  corsHeadersFor,
  methodNotAllowed,
  notFound,
  parseCookies,
  preflightHeaders,
  readFormBody,
  readJsonBody,
  respond,
  sendJson,
  DEFAULT_MAX_BODY_BYTES,
} from './http-utils.mjs';
import { SESSION_COOKIE } from './authn.mjs';
import { discoveryDocument } from './oidc.mjs';
import { jwksDocument } from './keys.mjs';
import * as api from './api.mjs';

function matchPath(pathname, pattern) {
  // pattern like /api/notes/{uid}
  const patParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith('{')) {
      params[patParts[i].slice(1, -1)] = pathParts[i];
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// Extract + validate the client authentication for the token/revocation
// endpoints: client_secret_basic (RFC 6749 §2.3.1), client_secret_post, or
// none (public clients). Returns { method, clientId, clientSecret, basicInvalid }.
function clientAuthFrom(req, form) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && /^Basic\s/i.test(header)) {
    try {
      const decoded = Buffer.from(header.replace(/^Basic\s+/i, '').trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon <= 0) return { method: 'basic', clientId: undefined, clientSecret: undefined, basicInvalid: true };
      return {
        method: 'basic',
        clientId: decodeURIComponentStrict(decoded.slice(0, colon)),
        clientSecret: decodeURIComponentStrict(decoded.slice(colon + 1)),
        basicInvalid: false,
      };
    } catch {
      return { method: 'basic', clientId: undefined, clientSecret: undefined, basicInvalid: true };
    }
  }
  const clientId = form.get('client_id');
  const clientSecret = form.get('client_secret');
  if (clientId || clientSecret) {
    return {
      method: clientSecret ? 'post' : 'none',
      clientId: clientId ? String(clientId) : undefined,
      clientSecret: clientSecret ? String(clientSecret) : undefined,
      basicInvalid: false,
    };
  }
  return { method: 'none', clientId: undefined, clientSecret: undefined, basicInvalid: false };
}

function decodeURIComponentStrict(value) {
  const once = decodeURIComponent(value);
  // Reject double-encoded ids ('%25' decoded again would differ).
  return decodeURIComponent(once) === once ? once : decodeURIComponent(once);
}

export function createRouter({ config, store, oidc, keys, sessions }) {
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function route(req, res) {
    // HEAD is served by the GET handlers everywhere GET is served (Node's HTTP
    // server suppresses the response body for HEAD requests), so the dispatch
    // below stays single-tracked.
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const cors = corsHeadersFor(origin);

    // `new URL` + percent-decoding can throw on malformed request targets
    // (e.g. raw `GET /%zz`). This MUST be caught here: the try/catch below
    // only covers the dispatch, so a throw from these lines escapes the
    // router as an uncaughtException and kills the process (one malformed
    // request would be a remote DoS).
    let url;
    let pathname;
    try {
      url = new URL(req.url ?? '/', config.issuer);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'malformed request target',
      }, cors);
    }

    // CORS preflight for every route (browser clients may preflight the OIDC
    // endpoints too when using fetch cross-origin).
    if (method === 'OPTIONS') {
      return respond(res, 204, preflightHeaders(origin));
    }

    try {
      req.parsedCookies = parseCookies(req);
      // --- well-known & discovery -----------------------------------------
      if (method === 'GET' && pathname === '/.well-known/openid-configuration') {
        return sendJson(res, 200, discoveryDocument(config.issuer), {
          ...cors,
          'Cache-Control': 'public, max-age=300',
        });
      }
      if (method === 'GET' && (pathname === '/jwks.json' || pathname === '/.well-known/jwks.json')) {
        return sendJson(res, 200, jwksDocument(keys), { ...cors, 'Cache-Control': 'public, max-age=300' });
      }

      // --- authorize -------------------------------------------------------
      if (pathname === '/authorize' && method === 'GET') {
        return oidc.authorize(req, res, url.searchParams);
      }
      if (pathname === '/authorize/submit' && req.method === 'POST') {
        const form = await readFormBody(req, maxBody);
        return oidc.submitLogin(req, res, form);
      }

      // --- token (form-encoded only; JSON bodies get 415 per spec decision)
      if (pathname === '/token') {
        if (method !== 'POST') {
          return methodNotAllowed(res, 'POST', cors);
        }
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/application\/x-www-form-urlencoded/i.test(ctype)) {
          return sendJson(res, 415, {
            error: 'invalid_request',
            error_description: 'the token endpoint accepts application/x-www-form-urlencoded bodies only',
          }, cors);
        }
        const form = await readFormBody(req, maxBody);
        const result = oidc.token(form, clientAuthFrom(req, form));
        return sendJson(res, result.status, result.body, { ...cors, ...result.headers });
      }

      // --- userinfo --------------------------------------------------------
      if (pathname === '/userinfo' && method === 'GET') {
        const payload = api.requireBearer(oidc, req, res, origin, { scope: 'openid' });
        if (!payload) return;
        return sendJson(res, 200, oidc.userinfo(payload), cors);
      }

      // --- revocation (RFC 7009) ---------------------------------------------
      if (pathname === '/revoke' && method === 'POST') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/application\/x-www-form-urlencoded/i.test(ctype)) {
          return sendJson(res, 415, { error: 'invalid_request', error_description: 'the revocation endpoint accepts application/x-www-form-urlencoded bodies only' }, cors);
        }
        const form = await readFormBody(req, maxBody);
        const result = oidc.revoke(form, clientAuthFrom(req, form));
        return result.body === ''
          ? respond(res, result.status, { ...cors, ...result.headers })
          : sendJson(res, result.status, result.body, { ...cors, ...result.headers });
      }

      // --- notes API ---------------------------------------------------------
      const notesMatch = matchPath(pathname, '/api/notes/{uid}');
      if (pathname === '/api/notes' || notesMatch) {
        const allowed = 'GET, HEAD, PUT, DELETE, OPTIONS';
        const methods = { GET: true, PUT: true, DELETE: true };
        if (!methods[method]) {
          return methodNotAllowed(res, allowed, cors);
        }
        // AuthN + scope. Scope failure → 403; missing/bad token → 401.
        const payload = api.requireBearer(oidc, req, res, origin, { scope: 'notes.sync' });
        if (!payload) return;
        const ctx = { store, oidc, payload, origin, config };
        if (pathname === '/api/notes' && method === 'GET') {
          return api.getManifest(req, res, ctx);
        }
        if (notesMatch) {
          const uid = notesMatch.uid;
          api.assertSafeUid(uid);
          const inner = { ...ctx, uid };
          if (method === 'GET') {
            return api.getNote(req, res, inner);
          }
          if (method === 'PUT') {
            inner.jsonBody = await readJsonBody(req, maxBody);
            return api.putNote(req, res, inner);
          }
          if (method === 'DELETE') {
            return api.deleteNote(req, res, inner);
          }
        }
      }

      // --- root landing page ---------------------------------------------------
      if (pathname === '/' && method === 'GET') {
        return respond(res, 200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...cors,
        }, landingHtml(config.issuer));
      }

      if (pathname === '/healthz' && method === 'GET') {
        return sendJson(res, 200, { ok: true, issuer: config.issuer }, cors);
      }

      // --- fallbacks -------------------------------------------------------------
      // If the path looks like /api/*, return a JSON 404; otherwise a JSON 404
      // is still the most useful for API-first usage.
      return notFound(res, `${req.method} ${pathname}`, cors);
    } catch (err) {
      if (err && err.status && err.payload !== undefined) {
        const headers = { ...cors, ...err.headers };
        return sendJson(res, err.status, err.payload, headers);
      }
      console.error('[server] unhandled error:', err);
      return sendJson(res, 500, { error: 'server_error', error_description: 'internal server error' }, cors);
    }
  };
}

function landingHtml(issuer) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Note Haven sync server</title>
<style>
 body { font-family: ui-serif, Georgia, serif; background:#f6f4ef; color:#2c2a26; display:grid; place-items:center; min-height:100vh; margin:0; }
 main { max-width: 480px; background:#fffdf9; border:1px solid #e4ded2; border-radius:14px; padding:32px; }
 code { background:#f0ece2; padding:2px 5px; border-radius:5px; font-size:0.85em; }
 a { color:#5f7355; }
</style></head>
<body><main>
<h1>Note Haven sync server</h1>
<p>A reference multi-user sync server with OpenID Connect login.</p>
<p>Discovery: <code><a href="/.well-known/openid-configuration">/.well-known/openid-configuration</a></code></p>
<p>Notes API: <code>GET/PUT/DELETE /api/notes…</code> with <code>Authorization: Bearer …</code></p>
<p><small>issuer: <code>${issuer}</code></small></p>
</main></body></html>
`;
}

export { SESSION_COOKIE };