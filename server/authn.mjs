// Login handling: scrypt password verification, login submission processing,
// and session-cookie issuance. Sessions are in-memory (a server restart logs
// users out — acceptable and documented for a reference server); the cookie
// value itself is HMAC-signed so it cannot be forged without the server
// secret.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { HttpError, escapeHtml, serializeCookie } from './http-utils.mjs';

export const SESSION_COOKIE = 'nh_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

// scrypt defaults (N=16384, r=8, p=1) with a 16-byte random salt per user.
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  if (typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
  const actual = scryptSync(String(password), salt, 64);
  let expected;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}

export class SessionManager {
  constructor({ secret, now = () => Date.now(), ttlSeconds = SESSION_TTL_SECONDS } = {}) {
    this.secret = secret;
    this.now = now;
    this.ttl = ttlSeconds;
    this.sessions = new Map(); // sid -> { sub, username, expiresAt }
  }

  create(user) {
    const sid = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.ttl * 1000;
    this.sessions.set(sid, { sub: user.sub, username: user.username, expiresAt });
    this.prune();
    return { sid, expiresAt, cookie: this.cookieFor(sid, this.ttl) };
  }

  cookieFor(sid, maxAge) {
    return serializeCookie(SESSION_COOKIE, this.sign(sid), {
      maxAge,
      httpOnly: true,
      sameSite: 'Lax',
      // Secure is intentionally omitted: the reference server is plain HTTP on
      // localhost. A TLS deployment should turn it on.
    });
  }

  sign(sid) {
    const mac = createHmac('sha256', this.secret).update(sid).digest('base64url');
    return `${sid}.${mac}`;
  }

  // Returns the session record for a valid, unexpired, correctly signed
  // cookie value; null otherwise.
  verify(cookieValue) {
    if (typeof cookieValue !== 'string') return null;
    const dot = cookieValue.lastIndexOf('.');
    if (dot <= 0) return null;
    const sid = cookieValue.slice(0, dot);
    const mac = cookieValue.slice(dot + 1);
    const expected = createHmac('sha256', this.secret).update(sid).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (this.now() > session.expiresAt) {
      this.sessions.delete(sid);
      return null;
    }
    return session;
  }

  destroy(sid) {
    this.sessions.delete(sid);
  }

  prune() {
    const now = this.now();
    for (const [sid, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(sid);
    }
  }
}

// Process a POST /authorize/submit login. Returns the user or throws an
// HttpError(401) with a rendered login page on failure (the caller decides how
// to surface it).
//
// The identifier field accepts EITHER the username or the email (one-pass
// lookup in the store; both unique per user). Missing users and wrong
// passwords must stay indistinguishable: the decoy scrypt below keeps
// unknown-identifier responses in the same latency band as a wrong password.
// The password is only compared via scrypt + timingSafeEqual — never by any
// map/index lookup — so lookup timing cannot leak credential material.
export function authenticate(store, { username, password }) {
  const user = store.findUserByUsernameOrEmail(String(username ?? ''));
  if (!user) {
    // Burn comparable time so a missing user is not distinguishable from a
    // wrong password by response latency.
    scryptSync(String(password ?? ''), 'decoy-salt', 64);
    throw new HttpError(401, { error: 'invalid_credentials' });
  }
  if (!verifyPassword(password, user.salt, user.hash)) {
    throw new HttpError(401, { error: 'invalid_credentials' });
  }
  return user;
}

export function loginPageHtml({ action, error = '', username = '' } = {}) {
  const errBlock = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Note Haven</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: ui-serif, Georgia, 'Times New Roman', serif;
    background: #f6f4ef;
    color: #2c2a26;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  main {
    width: 100%;
    max-width: 360px;
    background: #fffdf9;
    border: 1px solid #e4ded2;
    border-radius: 14px;
    padding: 32px 28px;
    box-shadow: 0 10px 30px rgba(60, 50, 30, 0.08);
  }
  h1 { font-size: 1.45rem; font-weight: 600; letter-spacing: -0.01em; }
  p.sub { margin-top: 6px; font-size: 0.9rem; color: #7a7468; }
  form { margin-top: 22px; display: grid; gap: 14px; }
  label { display: grid; gap: 5px; font-size: 0.82rem; color: #5c564c; }
  input {
    font: inherit; font-size: 0.95rem; padding: 10px 12px;
    border: 1px solid #d8d1c2; border-radius: 9px; background: #fff;
    color: inherit; width: 100%;
  }
  input:focus { outline: 2px solid #8a9a7b; outline-offset: 1px; border-color: #8a9a7b; }
  button {
    margin-top: 4px; font: inherit; font-weight: 600; font-size: 0.95rem;
    padding: 11px 14px; border: 0; border-radius: 9px; cursor: pointer;
    background: #5f7355; color: #fdfcf8;
  }
  button:hover { background: #52634a; }
  .error {
    margin-top: 14px; font-size: 0.85rem; color: #8c3a2e;
    background: #f9ece9; border: 1px solid #ecccc5;
    border-radius: 8px; padding: 9px 11px;
  }
  footer { margin-top: 20px; font-size: 0.75rem; color: #9a9384; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>Note Haven</h1>
  <p class="sub">Sign in to authorise this app to sync your notes.</p>
  ${errBlock}
  <form method="post" action="${escapeHtml(action)}">
    <label>Username or email
      <input name="username" value="${escapeHtml(username)}" autocomplete="username" required autofocus>
    </label>
    <label>Password
      <input name="password" type="password" autocomplete="current-password" required>
    </label>
    <button type="submit">Sign in</button>
  </form>
  <footer>Note Haven reference server · local development</footer>
</main>
</body>
</html>
`;
}

/**
 * Handoff page shown after a successful login POST. Chromium applies the
 * posting page's `form-action 'self'` CSP to the RESPONSE side of the form
 * submission as well: a 302 whose Location leaves the origin aborts the
 * navigation with a CSP violation (verified with a real-browser A/B —
 * same-origin 302 passes, cross-origin 302 to the app's /auth/callback is
 * blocked). The CSP must stay strict, so instead of redirecting we return a
 * minimal 200 page that meta-refreshes to the redirect_uri: a meta refresh is
 * a document-initiated navigation and is not covered by form-action. The
 * visible link is the no-JS/no-meta fallback (and the only visible content
 * for the ~one frame the refresh takes).
 */
export function handoffPageHtml(target) {
  const safeTarget = escapeHtml(target);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${safeTarget}">
<title>Signed in — Note Haven</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: ui-serif, Georgia, 'Times New Roman', serif;
    background: #f6f4ef; color: #2c2a26; min-height: 100vh;
    display: grid; place-items: center; padding: 24px; margin: 0;
  }
  main {
    max-width: 420px; background: #fffdf9; border: 1px solid #e4ded2;
    border-radius: 14px; padding: 32px 28px;
  }
  h1 { font-size: 1.3rem; font-weight: 600; }
  p { margin-top: 10px; font-size: 0.92rem; line-height: 1.5; color: #5c564c; }
  a { color: #5f7355; }
</style>
</head>
<body><main><h1>Signed in</h1><p>Returning to the application… <a href="${safeTarget}">Continue</a></p></main></body>
</html>
`;
}

export function errorPageHtml(title, detail) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Note Haven</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: ui-serif, Georgia, 'Times New Roman', serif;
    background: #f6f4ef; color: #2c2a26; min-height: 100vh;
    display: grid; place-items: center; padding: 24px; margin: 0;
  }
  main {
    max-width: 420px; background: #fffdf9; border: 1px solid #e4ded2;
    border-radius: 14px; padding: 32px 28px;
  }
  h1 { font-size: 1.3rem; color: #8c3a2e; }
  p { margin-top: 10px; font-size: 0.92rem; line-height: 1.5; color: #5c564c; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>
`;
}