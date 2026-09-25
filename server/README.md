# Note Haven sync server (reference implementation)

A multi-user sync server for the Note Haven app with a built-in OpenID
Connect provider (Authorization Code + PKCE). Implements the wire contract in
[`docs/sync.md`](../docs/sync.md) — and adds real authentication on top.

**Zero third-party dependencies.** Node.js >= 20 stdlib only
(`node:http`, `node:crypto`, `node:fs/promises`, `node:path`, `node:url`).

## Run

```bash
node server/index.mjs --port 8080
```

Startup log:

```
Note Haven sync server listening on http://localhost:8080
Issuer: http://localhost:8080
Dev users: alice@example.com / correct-horse-battery-staples, bob@example.com / correct-horse-staple
Dev client: client_id=note-haven-dev client_secret=dev-secret-not-for-prod
Data dir: server/data
Signing key: kid=<16-hex> (newly generated)
```

### Options

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--port` | `PORT` | `8080` | TCP port |
| `--host` | `HOST` | `localhost` | bind address |
| `--data-dir` | `NOTEHAVEN_DATA_DIR` | `server/data` | state directory |
| `--issuer` | `NOTEHAVEN_ISSUER` | `http://<host>:<port>` | OIDC issuer URL (set when behind a proxy) |
| — | `NOTEHAVEN_EXCLUDED_CATEGORIES` | *(empty)* | Comma-separated category names that must never sync (exact, case-sensitive match) |
| — | `NOTEHAVEN_EXCLUDED_NOTES` | *(empty)* | Comma-separated note uids that must never sync |

Precedence: defaults < env < CLI flags.

Sync exclusions (deny lists): PUT for an excluded category/uid → `403
{"error":"excluded",…}`; the manifest omits excluded uids entirely (even
tombstones); DELETE stays allowed. Advertised in discovery as
`notes.excluded_categories` / `notes.excluded_uids` when non-empty. Full
details: [docs/server-admin.md](../docs/server-admin.md).

## Dev credentials (local only)

| Kind | Value |
|---|---|
| User 1 | `alice` / `correct-horse-battery-staples` (email `alice@example.com`) |
| User 2 | `bob` / `correct-horse-staple` (email `bob@example.com`) |
| Confidential client | `client_id=note-haven-dev`, `client_secret=dev-secret-not-for-prod` |
| Public (PKCE-only) client | `client_id=note-haven-pkce` |
| Redirect URIs (both clients) | `http://localhost:4173/auth/callback` |

Users are seeded on first start (idempotent); they persist in
`server/data/users.json`. Passwords are stored as scrypt hashes with per-user
salts.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/.well-known/openid-configuration` | — | OIDC discovery document |
| GET | `/jwks.json` (alias `/.well-known/jwks.json`) | — | RSA public keys as JWK |
| GET | `/authorize` | — | Authorization endpoint; renders the login page |
| POST | `/authorize/submit` | — | Login form target (keeps `/authorize` OIDC-clean) |
| POST | `/token` | client auth | Token exchange (`authorization_code`, `refresh_token`); other methods → `405 Allow: POST` |
| GET | `/userinfo` | Bearer (scope `openid`) | Subject claims |
| POST | `/revoke` | client auth | RFC 7009 token revocation |
| GET | `/api/notes` | Bearer (scope `notes.sync`) | Manifest `{ notes: [{ uid, updatedAt, deleted? }] }` |
| GET | `/api/notes/{uid}` | Bearer | Full note payload; tombstoned uid → 404 |
| PUT | `/api/notes/{uid}` | Bearer | Upsert (body = full note payload); a body `uid` must equal the path uid → else 400; excluded category/uid → 403 `excluded` |
| DELETE | `/api/notes/{uid}` | Bearer | Tombstone (never hard-delete; idempotent; allowed even for excluded uids) |
| GET | `/healthz` | — | Liveness |
| OPTIONS | any | — | CORS preflight → 204 |
| HEAD | wherever GET is served | same as GET | Same status as GET; body suppressed (Node auto-handles this) |

Errors are JSON `{ error, error_description }`; 401 responses carry
`WWW-Authenticate: Bearer …`; 405 responses carry `Allow`. Malformed request
targets that cannot be parsed or percent-decoded (e.g. `GET /%zz`) are
rejected with `400 invalid_request` without crashing the process.

## OIDC flow walkthrough (curl)

```bash
# 0. boot
node server/index.mjs --port 8080 &

ISS=http://localhost:8080
CLIENT_ID=note-haven-dev
CLIENT_SECRET=dev-secret-not-for-prod
REDIRECT=http://localhost:4173/auth/callback

# 1. PKCE verifier + S256 challenge (node stdlib)
VERIFIER=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")
CHALLENGE=$(node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1],'ascii').digest('base64url'))" "$VERIFIER")

# 2. Discovery document
curl -s $ISS/.well-known/openid-configuration

# 3. Authorization request → 200 HTML login page (no hidden fields — the OIDC
#    request context rides in the short-lived nh_pending HttpOnly cookie)
curl -s -c cookies.txt "$ISS/authorize?client_id=$CLIENT_ID&redirect_uri=$REDIRECT&response_type=code&scope=openid%20offline_access%20notes.sync&state=dev-state-123&nonce=n-123&code_challenge=$CHALLENGE&code_challenge_method=S256" -o login.html

# 4. Submit credentials → 200 handoff page whose meta refresh carries
#    code=…&state=dev-state-123 to redirect_uri (a 302 would be blocked by the
#    login page's form-action 'self' CSP — Chromium checks the redirect too)
curl -s -b cookies.txt -c cookies.txt \
  --data-urlencode username=alice \
  --data-urlencode password=correct-horse-battery-staples \
  $(grep -o 'action="[^"]*"' login.html | cut -d'"' -f2) \
  | grep -o 'content="0;url=[^"]*"'
LOCATION='…the meta-refresh URL from above (HTML-escaped: &amp; → &)...'
CODE=$(node -e "console.log(new URL(process.argv[1]).searchParams.get('code'))" "$LOCATION")

# 5. Exchange the code (PKCE verifier + client_secret_post) → tokens
curl -s $ISS/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=authorization_code \
  --data-urlencode code=$CODE \
  --data-urlencode redirect_uri=$REDIRECT \
  --data-urlencode code_verifier=$VERIFIER \
  --data-urlencode client_id=$CLIENT_ID \
  --data-urlencode client_secret=$CLIENT_SECRET
# → { access_token, token_type:"Bearer", expires_in:3600, refresh_token, id_token, scope }

# 6. Refresh (rotation): replaying the OLD refresh token revokes the family.
curl -s $ISS/token -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=refresh_token \
  --data-urlencode refresh_token=$REFRESH \
  --data-urlencode client_id=$CLIENT_ID \
  --data-urlencode client_secret=$CLIENT_SECRET

# 7. Use the access token against the sync API
TOKEN='…access_token…'
curl -s -H "Authorization: Bearer $TOKEN" $ISS/api/notes
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"uid":"demo","title":"Hello","content":"world","category":"General","updatedAt":"2026-09-20T01:00:00.000Z"}' \
  $ISS/api/notes/demo
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $ISS/api/notes/demo
curl -s -H "Authorization: Bearer $TOKEN" $ISS/api/notes   # demo → deleted:true

# 8. Revocation (RFC 7009) — always 200
curl -s -X POST $ISS/revoke -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode token=$REFRESH \
  --data-urlencode client_id=$CLIENT_ID \
  --data-urlencode client_secret=$CLIENT_SECRET
```

Verify an access token JWT with any standard library — signature is RS256
(RSASSA-PKCS1-v1_5 / SHA-256), key from `/jwks.json`:

```bash
node -e "
import('./server/jwt.mjs').then(({verifyJwt}) => {
  const fs = require('node:fs');
  const keys = JSON.parse(fs.readFileSync('server/data/keys.json','utf8'));
  const { payload } = verifyJwt(process.argv[1], keys.publicPem, { issuer: process.argv[2] });
  console.log(payload);
});" "$TOKEN" "$ISS"
```

## Design decisions & spec choices (documented deviations)

- **invalid_client → 400.** RFC 6749 §5.2 allows 400 or 401 for
  `invalid_client`; this server returns **400** and adds
  `WWW-Authenticate: Basic realm="note-haven-token", error="invalid_client"`
  when Basic credentials were supplied. Reason: simpler uniform error handling
  for browser and SPA clients; the header keeps the challenge discoverable.
- **Code replay.** A replayed authorization code is rejected with
  `invalid_grant`. Tokens from the *first* exchange stay valid for their
  (one hour) lifetime — full retroactive revocation per RFC 6749 §4.1.2's
  "SHOULD" would require a code→jti registry; the short access-token TTL
  (1 h) bounds the exposure. Refresh tokens rotate on every use.
- **Refresh reuse → family revocation.** Replaying a rotated refresh token
  invalidates every token in its family (draft-ietf-oauth-security-topics
  §4.13.2).
- **Token endpoints are form-encoded only.** JSON bodies to `/token` or
  `/revoke` get **415** with an `invalid_request` JSON body.
- **`updatedAt` is client-authoritative on PUT** (per docs/sync.md — the
  client is the conflict clock). Server clock is used only when the payload
  lacks a parseable `updatedAt`. DELETE sets `updatedAt` to the **server**
  clock so a tombstone always sorts after everything deleted before it.
- **Tombstones are forever.** DELETE keeps the manifest entry
  (`deleted: true` + `updatedAt`); `GET` on a tombstoned uid → 404; `PUT` to a
  tombstoned uid resurrects it. There is no hard-delete, so the client's
  deletion-ordering logic never loses information.
- **CORS: Origin echo.** `Access-Control-Allow-Origin` echoes the request
  Origin with `Access-Control-Allow-Credentials: false`. Acceptable for a
  reference/private deployment because bearer tokens (not cookies) guard the
  API; a public deployment should pin an allowlist. Preflight answers
  `GET, PUT, DELETE, POST, OPTIONS`, allows `Authorization, Content-Type`,
  and caches for 24 h (`Access-Control-Max-Age`). 204/304 responses never
  carry `Content-Type`.
- **Sessions are in-memory.** A restart logs browser sessions out and drops
  outstanding authorization codes/refresh tokens (access tokens survive —
  they are self-contained JWTs). Acceptable for a reference server; the data
  files are NOT lost (SIGINT/SIGTERM flush synchronously before exit).
- **aud = client_id.** The access token's `aud` is the client's id; no
  separate resource-indicator audience is modelled. The API accepts any token
  signed by this issuer that carries the `notes.sync` scope.

## Security notes & limits (NOT production-hardened)

- **HTTP only** — no TLS. Terminating TLS is the deployment's responsibility
  (set `--issuer`/`NOTEHAVEN_ISSUER` when proxying).
- **Origin-echo CORS** (see above) — fine here, wrong for the public internet.
- **In-memory grant state** — authorization codes, refresh tokens, sessions
  and revocation lists do not survive restart. Single-process only; no
  clustering.
- **No rate limiting / lockout** on login or the token endpoint.
- **No CSRF token** on the login form (SameSite=Lax cookie + form-action 'self'
  CSP mitigate; a hardened deployment would add a token).
- **No HTTPS-only cookie flag** (`Secure` omitted since the server is plain
  HTTP on localhost).
- **Revocation list is in-memory** — revoked access tokens become valid again
  after a restart (they also expire within the hour).
- **No audit log.** Console output is the only record.
- Password hashing is scrypt (N=16384, r=8, p=1, 64-byte key) with 16-byte
  random salts and timing-safe comparison.

## Data layout (`server/data/`, gitignored)

| File | Contents |
|---|---|
| `users.json` | `{ users: [{ sub, username, email, name, salt, hash, created_at }] }` |
| `clients.json` | `{ clients: [{ client_id, client_secret?, redirect_uris, public }] }` |
| `keys.json` | `{ kid, privatePem, publicPem }` — RS256 signing key, generated once, `kid` derived from the public key so it is stable across restarts |
| `notes-<userId>.json` | `{ notes: [{ uid, deleted, updatedAt, storedAt, payload }] }` — one file per user |

Writes are debounced (~50 ms) and atomic (temp file + rename). SIGINT/SIGTERM
flush every pending write synchronously before exit, so Ctrl+C never loses
data. **Restarting logs users out** (in-memory sessions) — noted above.

## Tests

```bash
node --test "server/test/*.test.mjs"
```

Covers: JWT roundtrip + alg-confusion (`none`, HS256) + exp/iss/aud checks;
PKCE S256 (incl. RFC 7636 appendix-B vector) and wrong-verifier rejection;
token-endpoint client auth (basic/post/none); code single-use; refresh
rotation + family reuse detection; revocation; multi-user isolation;
tombstone lifecycle (PUT → DELETE → manifest `deleted:true` → GET 404 → PUT
resurrects); CORS preflight; 1 MiB body cap; 415 on JSON to `/token`; scope
enforcement (403 without `notes.sync`).

## What is intentionally out of scope

- Real client registration UI (clients are seeded `clients.json` entries).
- Category-scoped tokens (`notes.categories` claim is always `["*"]`); the
  client is expected to filter. Designed so a future server can narrow the
  claim without breaking the wire format.
- Push/webhooks, real-time sync, attachments deduplication.