# Server administration guide

**Audience:** sysadmins and developers running the Note Haven sync server.
**Reading time:** ~6 min.

For the user-facing behaviour of exclusions see
[exclusions.md](exclusions.md) (app users) and
[sync.md](sync.md) (protocol). This page covers only how to run and
configure the server itself.

---

## Running the server (~30 sec)

Zero dependencies — Node's standard library only (Node 20+):

```sh
cd <repo>
node server/index.mjs --port 8080
```

The server prints its issuer URL, data dir, and port on boot. Health check:

```sh
curl http://localhost:8080/healthz
```

## Configuration

Precedence: **built-in defaults < environment variables < CLI flags.**

| Env var | CLI flag | Default | Meaning |
|---|---|---|---|
| `PORT` | `--port` | `8080` | Listen port |
| `HOST` | `--host` | `localhost` | Bind address |
| `NOTEHAVEN_DATA_DIR` | `--data-dir` | `server/data` | JSON storage directory |
| `NOTEHAVEN_ISSUER` | `--issuer` | `http://<host>:<port>` | OIDC issuer URL |
| `NOTEHAVEN_EXCLUDED_CATEGORIES` | — | *(empty)* | Comma-separated category names that must never sync |
| `NOTEHAVEN_EXCLUDED_NOTES` | — | *(empty)* | Comma-separated note uids that must never sync |

## Sync exclusions (deny lists)

Set either variable to keep content off the server entirely:

```sh
NOTEHAVEN_EXCLUDED_CATEGORIES="Private,Legal" \
NOTEHAVEN_EXCLUDED_NOTES="note-uid-1,note-uid-2" \
node server/index.mjs --port 8080
```

Rules:

- **Matching is exact and case-sensitive.** `Private` does not match
  `private` — a category is whatever string the client stores in the note's
  `category` field, and there is no canonical casing to normalize against.
- Entries are trimmed of surrounding whitespace; empty entries are dropped.
- Empty/absent variables mean **nothing is denied**. The server never
  invents policy.

### What the server enforces

| Surface | Behaviour when excluded |
|---|---|
| `PUT /api/notes/{uid}` | `403 {"error":"excluded","error_description":"category \"X\" is excluded on this server"}` (uid deny: analogous message) |
| `GET /api/notes` (manifest) | Excluded uids are **omitted entirely** — not even their tombstones are listed |
| `GET /api/notes/{uid}` | Excluded uids never exist for new clients (they can only exist if synced *before* the policy was set) — a pre-existing excluded record still serves via direct GET (documented behavior) |
| `DELETE /api/notes/{uid}` | **Allowed.** Exclusions govern content sync, not lifecycle bookkeeping |

Discovery (`/.well-known/openid-configuration`) advertises the policy so
clients can explain themselves:

```json
"notes": {
  "excluded_categories": ["Private", "Legal"],
  "excluded_uids": []
}
```

The `notes` key is **omitted entirely** when nothing is excluded, keeping the
discovery document byte-identical to the pre-exclusion shape on servers that
do not opt in.

## The precedence model (why your deny list always wins)

A note syncs only if **every layer** allows it. Deny always wins, at either
layer:

| server deny (yours) | client allow (user's scope) | client deny (user's device) | result |
|---|---|---|---|
| yes | — | — | **EXCLUDED** — never synced, never pulled |
| no | no | — | EXCLUDED (out of scope) |
| no | yes | no | ALLOWED |
| no | yes | yes | EXCLUDED (client deny beats client allow) |

Practical consequences for you as the admin:

- A user who selects an excluded category as a "synced category" in the app
  gets **no** error — the notes in it simply never leave their device. The
  app shows those categories with a lock badge ("Denied by server policy").
- Adding a category to the deny list takes effect **immediately at the next
  sync** — already-synced copies stop being pushed or pulled. Notes already
  stored on the server *stay there* (the policy blocks future writes; it does
  not scrub history). Remove them with `DELETE /api/notes/{uid}` if needed.
- A client that ignores discovery still cannot store excluded content: the
  `PUT` is refused with 403 regardless of what the client believes.

## Docker example

```sh
docker run -p 8080:8080 \
  -e NOTEHAVEN_EXCLUDED_CATEGORIES="Private,Legal" \
  -e NOTEHAVEN_DATA_DIR=/data \
  -v note-haven-data:/data \
  note-haven-sync
```

(image name illustrative — use the image your deployment builds/publishes)

docker-compose:

```yaml
services:
  sync:
    image: note-haven-sync
    ports: ["8080:8080"]
    environment:
      NOTEHAVEN_EXCLUDED_CATEGORIES: "Private,Legal"
      NOTEHAVEN_EXCLUDED_NOTES: ""
    volumes:
      - note-haven-data:/data
volumes:
  note-haven-data:
```

## Security notes

- Exclusions are **content policy, not access control.** Any authenticated
  user can still sync their own non-excluded notes; one user's exclusion list
  is the same for all users (it is server-wide, not per-user).
- The manifest omits excluded uids so their *existence* is not leaked to
  clients that never synced them. A client that synced a uid **before** the
  exclusion was introduced may still hold that uid in its local caches.
- Denied `PUT`s return the category name in `error_description` — that is
  intentional (the client needs to explain the refusal) and reveals nothing
  about other users' data.
- Excluded-note payloads already accepted before a policy change remain on
  disk until deleted (see above). Plan migrations accordingly.

## Interaction with existing synced data

1. **Introduce an exclusion:** next sync skips the category/uids in both
   directions. Local copies stay untouched (the client never deletes).
2. **Remove an exclusion:** notes resume syncing at the next round — the
   client keeps uid mappings for skipped notes, so no re-uploads of new
   copies happen; ordinary last-writer-wins merges resume.
3. **Server-side deletions of excluded notes** never generate
   keep-or-delete prompts on clients: an excluded note is not managed by the
   syncing client, so its deletion is not its business.

## Tests

```sh
node --test "server/test/*.test.mjs"
```

The exclusion suite lives in `server/test/exclusions.test.mjs` (parsing,
discovery) and `server/test/exclusions-api.test.mjs` (HTTP enforcement).