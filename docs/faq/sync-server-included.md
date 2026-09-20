# FAQ: so is a server included now?

> **Question:** so is a server included now?

**Answer:**

No — the branch is client-side only. What exists now:

- **The app** can connect to any server implementing the protocol in `docs/sync.md` (4 endpoints: list manifest, get note, upsert, delete).
- **`docs/sync.md`** contains a ~20-line Express sketch showing how small a compatible server is, but it's documentation, not runnable code.
- There is **no server shipped in the repo** — you'd need to self-host one (Node, Deno, nginx+script, anything that speaks the contract).

If you want one included, the natural next step is a small reference implementation in the repo — e.g. `server/` with a single-file Node/Express app (JSON-file or SQLite storage), bearer-token auth, the CORS handling the client expects, plus its own tests and a Dockerfile so `docker run` gives you a working sync server. That would make the feature self-contained: run the server, paste its URL into Settings, sync.

Say the word and I'll build it on the same branch.