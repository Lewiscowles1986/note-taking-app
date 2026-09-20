// HTTP plumbing shared by every route module: request-body reading with a
// size cap, JSON/HTML/redirect responses, CORS headers, cookie parsing and
// serialization. Node stdlib only.
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export class HttpError extends Error {
  constructor(status, payload, headers = {}) {
    super(typeof payload === 'string' ? payload : (payload?.error ?? `HTTP ${status}`));
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
    this.headers = headers;
  }
}

export const CORS_ALLOW_METHODS = 'GET, PUT, DELETE, POST, OPTIONS';
export const CORS_ALLOW_HEADERS = 'Authorization, Content-Type';
export const CORS_MAX_AGE = '86400';

// Echo the request Origin. Fine for a reference/private deployment; a public
// deployment should pin an allowlist instead (documented in server/README.md).
export function corsHeadersFor(origin) {
  const headers = { Vary: 'Origin' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'false';
  }
  return headers;
}

export function preflightHeaders(origin) {
  return {
    ...corsHeadersFor(origin),
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': CORS_MAX_AGE,
  };
}

function bodyTooLarge(maxBytes) {
  return new HttpError(413, {
    error: 'payload_too_large',
    error_description: `request body exceeds the ${maxBytes} byte limit`,
  });
}

// Read the full request body, enforcing the size cap both up-front (when a
// Content-Length is present) and while streaming. On overflow the remaining
// body is drained (`req.resume()`) so the error response can still be
// delivered on the same connection.
export function readBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(req.headers?.['content-length'] ?? '', 10);
    if (Number.isInteger(declared) && declared > maxBytes) {
      reject(bodyTooLarge(maxBytes));
      return;
    }
    let size = 0;
    const chunks = [];
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        req.resume();
        reject(bodyTooLarge(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

export async function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const buf = await readBody(req, maxBytes);
  if (buf.length === 0) {
    throw new HttpError(400, {
      error: 'invalid_request',
      error_description: 'request body is empty; expected a JSON note payload',
    });
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, {
      error: 'invalid_request',
      error_description: 'request body is not valid JSON',
    });
  }
}

export async function readFormBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const buf = await readBody(req, maxBytes);
  return new URLSearchParams(buf.toString('utf8'));
}

export function respond(res, status, headers = {}, body = null) {
  const finalHeaders = { ...headers };
  const hasBody = body !== null && body !== undefined && status !== 204 && status !== 304;
  if (hasBody) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    finalHeaders['Content-Length'] = String(buf.byteLength);
    res.writeHead(status, finalHeaders);
    res.end(buf);
  } else {
    // Never send Content-Type (or a body) for 204/304 responses.
    delete finalHeaders['Content-Type'];
    res.writeHead(status, finalHeaders);
    res.end();
  }
}

export function sendJson(res, status, value, headers = {}) {
  return respond(
    res,
    status,
    { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    JSON.stringify(value),
  );
}

export function sendHtml(res, status, html, headers = {}) {
  return respond(res, status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }, html);
}

export function redirect(res, location, headers = {}) {
  return respond(res, 302, { Location: location, ...headers });
}

export const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

export const HTML_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

export function methodNotAllowed(res, allow, cors = {}) {
  return sendJson(
    res,
    405,
    { error: 'method_not_allowed', error_description: `allowed methods: ${allow}` },
    { Allow: allow, ...cors },
  );
}

export function notFound(res, what, cors = {}) {
  return sendJson(
    res,
    404,
    { error: 'not_found', error_description: `no route for ${what}` },
    cors,
  );
}

export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (typeof header !== 'string' || header.length === 0) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw value */
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, sameSite = 'Lax', path = '/', secure = false } = {}) {
  let cookie = `${name}=${value}; Path=${path}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (sameSite) cookie += `; SameSite=${sameSite}`;
  if (Number.isFinite(maxAge)) cookie += `; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
  if (secure) cookie += '; Secure';
  return cookie;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}