// The /api/notes routes — per-user note storage behind Bearer-token auth.
// Every access requires a valid access token with the notes.sync scope.
import { HttpError, NO_STORE, sendJson } from './http-utils.mjs';

const CORS_JSON = { 'Access-Control-Allow-Credentials': 'false' };

function bearerFrom(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

// Verifies the Bearer token and returns { payload } or writes the error
// response and returns null. 401 (with WWW-Authenticate) for missing/bad
// tokens; 403 (insufficient_scope) when a scope is required but absent.
export function requireBearer(oidc, req, res, origin, { scope } = {}) {
  const token = bearerFrom(req);
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, ...CORS_JSON } : CORS_JSON;
  if (!token) {
    sendJson(res, 401, { error: 'invalid_token', error_description: 'Authorization: Bearer <token> header is required' }, {
      ...cors,
      ...NO_STORE,
      'WWW-Authenticate': 'Bearer realm="note-haven-api"',
    });
    return null;
  }
  const result = oidc.verifyAccessToken(token, { scope });
  if (!result.ok) {
    const headers = { ...cors, ...NO_STORE };
    if (result.status === 403) headers['WWW-Authenticate'] = `Bearer realm="note-haven-api", error="insufficient_scope", scope="${scope}"`;
    else headers['WWW-Authenticate'] = 'Bearer realm="note-haven-api", error="invalid_token"';
    sendJson(res, result.status, { error: result.error, error_description: result.error_description }, headers);
    return null;
  }
  return result.payload;
}

// UID safety: opaque ASCII, no path separators, no percent-encoding tricks.
// The router already percent-decodes; reject anything suspicious here too.
export function assertSafeUid(uid) {
  if (!uid || uid.includes('/') || uid.includes('\\') || uid.includes('%') || uid.includes('?') || uid.includes('#')) {
    throw new HttpError(400, { error: 'invalid_request', error_description: `invalid note uid ${JSON.stringify(uid)}` });
  }
}

function withCors(origin, extra = {}) {
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin, ...CORS_JSON } : CORS_JSON),
    ...NO_STORE,
    ...extra,
  };
}

// GET /api/notes → manifest for the token's user only.
export function getManifest(req, res, ctx) {
  const { payload } = ctx;
  const manifest = ctx.store.manifest(payload.sub);
  return sendJson(res, 200, manifest, withCors(ctx.origin));
}

// GET /api/notes/{uid} → full payload; tombstoned uids 404.
export function getNote(req, res, ctx) {
  const { uid } = ctx;
  const record = ctx.store.notesFor(ctx.payload.sub).get(uid);
  if (!record || record.deleted) {
    return sendJson(res, 404, { error: 'not_found', error_description: uid + (record ? ' is deleted (tombstone)' : ' does not exist for this user') }, withCors(ctx.origin));
  }
  return sendJson(res, 200, record.payload, withCors(ctx.origin));
}

// PUT /api/notes/{uid} → upsert. updatedAt comes from the payload body (the
// client is the conflict clock per docs/sync.md); server clock only as
// fallback. Tombstoned uid → resurrect.
export async function putNote(req, res, ctx) {
  const { uid } = ctx;
  const payload = ctx.jsonBody;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'request body must be a JSON note payload' }, withCors(ctx.origin));
  }
  // The payload's uid must mirror the path uid (docs/sync.md). A mismatch is
  // a client bug — reject it instead of silently rewriting the body.
  if (payload.uid !== undefined && payload.uid !== uid) {
    return sendJson(res, 400, { error: 'invalid_request', error_description: 'body uid does not match path uid' }, withCors(ctx.origin));
  }
  const updatedAt =
    (typeof payload.updatedAt === 'string' && !Number.isNaN(Date.parse(payload.updatedAt)) && payload.updatedAt) ||
    ctx.store.now().toISOString();
  const notes = ctx.store.notesFor(ctx.payload.sub);
  const previous = notes.get(uid);
  const resurrected = Boolean(previous?.deleted);
  notes.set(uid, {
    uid,
    deleted: false,
    updatedAt,
    storedAt: ctx.store.now().toISOString(),
    payload: { ...payload, uid }, // payload mirrors the path uid per docs/sync.md
  });
  ctx.store.saveNotes(ctx.payload.sub);
  return sendJson(res, 200, { ok: true, uid, updatedAt, resurrected }, withCors(ctx.origin));
}

// DELETE /api/notes/{uid} → tombstone (never hard-delete; manifest entry is
// kept forever with deleted:true + updatedAt = server now). Idempotent.
export function deleteNote(req, res, ctx) {
  const { uid } = ctx;
  const notes = ctx.store.notesFor(ctx.payload.sub);
  const previous = notes.get(uid);
  const nowIso = ctx.store.now().toISOString();
  notes.set(uid, {
    uid,
    deleted: true,
    updatedAt: nowIso,
    storedAt: nowIso,
    payload: previous?.payload ?? null,
  });
  ctx.store.saveNotes(ctx.payload.sub);
  return sendJson(res, 200, { ok: true, uid, deleted: true, updatedAt: nowIso }, withCors(ctx.origin));
}