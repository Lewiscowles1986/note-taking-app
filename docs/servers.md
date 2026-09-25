# Multiple sync servers

The app can sync with **several servers at once**. Each configured server syncs
independently — its own settings, its own sign-in, its own schedule — and a
note syncs to **every** server whose scope admits it.

*Reading time: Tutorial ≈ 2 min · How-to ≈ 3 min · Explanation ≈ 5 min ·
Reference ≈ 2 min.* Wire protocol details (shared by every server):
[sync.md](sync.md).

---

## Tutorial — add a second sync server in 2 minutes

1. Open **Settings** (gear icon in the header). You land on the **Sync
   servers** page.
2. Under **Add a server**, paste the server URL (and an optional label), then
   press **Add server**. A row appears.
3. Press **Sync now** on the row. Done — that server syncs with your existing
   settings defaults, and nothing about your other servers changed.

## How-to

### Add / remove / rename a server

- **Add:** Servers page → *Add a server* → URL (+ optional label) → **Add
  server**. Adding a URL that is already configured does nothing (idempotent).
- **Rename:** press the server's label, edit, confirm. The label is display
  only — the server's identity never changes.
- **Remove:** press **Remove**, then **Remove** again on the confirmation.
  Everything that server owns on this device is wiped: its settings,
  tombstones, uid map, notification queue, Keep exceptions and sign-in. Other
  servers are untouched. Removing ALL servers is allowed (the app simply
  stops syncing). A server's URL is its identity, so correcting a typo'd URL
  means Remove + re-add: that loses the server's sign-in session, lastSync
  record and uid map, and its notes stay local and re-sync from scratch.

### Sign in per server

Each row has its own **Sign in / Sign out**. Signing in to server A never
touches server B's tokens, and each server keeps its own signed-in identity
(shown on the row). The OIDC issuer defaults to the sync server itself.

### Sync one server vs all

- **One server:** the **Sync now** button on its row.
- **All servers:** a sync run with no specific server (background auto-sync
  runs per server) syncs every configured server and reports a combined
  summary.
- **Automatic sync** is configured per server in that server's **Settings** —
  each server has its own interval, and servers with auto-sync off simply
  don't tick. Each server runs on its own timer, so one hung server cannot
  block the others — though its own tick has no per-server timeout (the
  browser's fetch timeout applies). If a sync attempt fails fatally (server
  unreachable), the row records a failed lastSync — ⚠ + timestamp + error —
  rather than staying at "Never synced".

### Re-configure one server

**Settings** on a row opens that server's full settings page (scope,
exclusions, token, cadence, **Forget server** — which wipes that server's
data only). **Back** returns to the servers page; **Close** (top right of the
servers page) closes both pages and returns to your notes.

## Explanation — why each server keeps its own identity

A sync server is a *separate world of notes*. Two servers hold different
copies of your notes, know them by different names, and delete them at
different times:

- **uid maps are per server.** A note pushed to server A gets uid `x`, and the
  same note pushed to server B gets an independent uid `y`. The mapping
  (local note id → uid) is remembered per server, so deletions and updates
  can be addressed correctly on each side.
- **Tombstones are per server.** Deleting a note locally records a tombstone
  for *each* server where the note has a uid — every server learns about the
  deletion. A server you remove (or never synced to) is not affected.
- **Tokens are per server.** Each server has its own OIDC session (or manual
  bearer token). A refresh-token failure on server A signs you out of A only.
- **Notifications compose.** If a note is deleted on server A but lives on
  server B, you get ONE prompt attributed to A ("deleted on
  `https://a.example`"). Choosing **Keep** adds the exception *for that
  server*; B keeps syncing the note normally.
- **Per-server exclusions compose with the device-wide note exclusion.**
  Scope, category deny-lists and server policy are evaluated per server — a
  note can be in scope on your work server and excluded from your private
  one. The note-level "exclude from sync" (sidebar action) is DEVICE-wide: it
  is a statement about the note on this device, so it applies to every
  server.

**Migration:** existing single-server setups migrate automatically on first
run — the old configuration becomes the first server slot, with its
tombstones, uid map, queue and sign-in carried over. Nothing is re-entered,
nothing is lost, and the legacy storage keys are kept (unread) as a safety
net. A corrupt legacy blob migrates nothing, and the done-marker is still
set, so the broken legacy keys are simply never read again; a legacy OIDC
blob without a server URL (signed in, never configured) is dropped. Because
the marker is written once, hand-clearing the servers list later will not
re-trigger the migration.

## Reference — storage keys on this device

All in `localStorage`; `<id>` is the normalized server URL (the server's
identity):

| Key | Scope | Contents |
|---|---|---|
| `notehaven.sync.servers` | global | the configured server list |
| `notehaven.sync.server.<id>` | per server | settings (token, scope, cadence, lastSync) |
| `notehaven.sync.tombstones.<id>` | per server | deletion tombstones for that server |
| `notehaven.sync.uidMap.<id>` | per server | noteId → uid FOR that server |
| `notehaven.sync.remoteCategories.<id>` | per server | uid → category cache for that server's scope filter |
| `notehaven.sync.notifications.<id>` | per server | that server's keep-or-delete queue |
| `notehaven.sync.keepExceptions.<id>` | per server | Keep decisions for that server |
| `notehaven.sync.oidc.<id>` | per server | that server's OIDC config + session |
| `notehaven.sync.excludedNotes` | global | DEVICE-wide note deny list |
| `notehaven.oidc.pending` | sessionStorage | the in-flight login (+ which server it belongs to) |

Page map: **gear → Sync servers** (list) → **Settings** on a row (that
server's details). The header **Close** on the servers page leaves both pages.
The server itself needs no multi-server support — this is entirely a client
concept; any server implementing the protocol in [sync.md](sync.md) works.