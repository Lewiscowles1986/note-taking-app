// Persistence layer for the Note Haven reference sync server. All state lives
// as JSON files under the data dir:
//   users.json          — user records (scrypt password hashes, profile claims)
//   clients.json        — registered OAuth clients
//   keys.json           — the RS256 signing key pair (generated once, reused)
//   notes-<userId>.json — one file per user with their notes + tombstones
//
// Writes are debounced + atomic (write temp file, rename over target).
// Nothing is lost on SIGINT/SIGTERM because index.mjs calls flushAllSync()
// before exit.
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { mkdirp, writeAtomic, writeAtomicSync } from './fs-utils.mjs';
import { DEV_CLIENT, DEV_CLIENT_PUBLIC } from './seed.mjs';

export class Store {
  // `io` bundles the async/sync writers so tests can inject an in-memory
  // filesystem and never touch the network or disk.
  constructor(dataDir, { io = { writeAsync: writeAtomic, writeSync: writeAtomicSync }, now = () => new Date() } = {}) {
    this.dataDir = dataDir;
    this.io = io;
    this.now = now;
    this.users = new Map(); // sub -> user
    this.clients = new Map(); // client_id -> client
    this.notes = new Map(); // userId -> Map<uid, noteRecord>
    this.pendingFlushes = new Map(); // fileName -> { timer, data }
  }

  filePath(name) {
    return path.join(this.dataDir, name);
  }

  async load() {
    // mkdir only when using the default (real) fs writers; tests inject an
    // in-memory io and never touch disk.
    if (this.io.writeAsync === writeAtomic) await mkdirp(this.dataDir);
    this.users = await loadUsers(this.filePath('users.json'));
    this.clients = await loadClients(this.filePath('clients.json'));
    // Seed both dev clients on first boot (idempotent): the confidential
    // client for the README curl walkthrough and the public PKCE-only client
    // the Note Haven PWA signs in with by default.
    for (const client of [DEV_CLIENT, DEV_CLIENT_PUBLIC]) {
      if (!this.clients.has(client.client_id)) {
        this.clients.set(client.client_id, { ...client });
        this.saveClients();
      }
    }
    this.notes = await loadNoteFiles(this.dataDir);
    // Every known user gets an (possibly empty) per-user notes map.
    for (const sub of this.users.keys()) this.notesFor(sub);
  }

  // --- flush ----------------------------------------------------------------

  scheduleFlush(fileName, object) {
    const data = JSON.stringify(object, null, 2) + '\n';
    const existing = this.pendingFlushes.get(fileName);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pendingFlushes.delete(fileName);
      this.io.writeAsync(this.filePath(fileName), data).catch((err) => {
        console.error(`[store] failed to persist ${fileName}: ${err.message}`);
      });
    }, 50);
    timer.unref?.();
    this.pendingFlushes.set(fileName, { timer, data });
  }

  // Write every debounced-but-not-yet-written file synchronously. Called on
  // SIGINT/SIGTERM so a Ctrl+C can never lose data.
  flushAllSync() {
    for (const [fileName, entry] of this.pendingFlushes.entries()) {
      clearTimeout(entry.timer);
      try {
        this.io.writeSync(this.filePath(fileName), entry.data);
      } catch (err) {
        console.error(`[store] failed to flush ${fileName}: ${err.message}`);
      }
    }
    this.pendingFlushes.clear();
  }

  // --- users ----------------------------------------------------------------

  saveUsers() {
    this.scheduleFlush('users.json', { users: [...this.users.values()] });
  }

  upsertUser(user) {
    const isNew = !this.users.has(user.sub);
    this.users.set(user.sub, user);
    this.saveUsers();
    if (isNew) {
      this.notesFor(user.sub); // allocate (empty) per-user map
      this.saveNotes(user.sub);
    }
    return user;
  }

  findUserByUsername(username) {
    for (const user of this.users.values()) {
      if (user.username === username) return user;
    }
    return null;
  }

  findUserByEmail(email) {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  /**
   * Single-pass login lookup: resolve an identifier that may be either the
   * username or the email. Both are unique per user, so at most one record
   * can match; a single scan answers "username OR email" without walking
   * the map twice.
   *
   * NOTE on timing: this lookup IS data-dependent by design (linear scan,
   * early return on match). That is safe here because the secret material —
   * the password — never touches this function; it is only compared later
   * via scrypt + timingSafeEqual (see authn.verifyPassword). Lookup timing
   * varies with map position/count for ANY identifier, known or unknown, so
   * it leaks nothing about existence. The existence-vs-password distinction
   * is equalized by the caller's decoy scrypt burn, not here.
   */
  findUserByUsernameOrEmail(identifier) {
    for (const user of this.users.values()) {
      if (user.username === identifier || user.email === identifier) return user;
    }
    return null;
  }

  findUserBySub(sub) {
    return this.users.get(sub) ?? null;
  }

  // --- clients --------------------------------------------------------------

  saveClients() {
    this.scheduleFlush('clients.json', { clients: [...this.clients.values()] });
  }

  getClient(clientId) {
    return this.clients.get(clientId) ?? null;
  }

  // --- notes ----------------------------------------------------------------

  notesFileName(userId) {
    return `notes-${userId}.json`;
  }

  notesFor(userId) {
    let m = this.notes.get(userId);
    if (!m) {
      m = new Map();
      this.notes.set(userId, m);
    }
    return m;
  }

  saveNotes(userId) {
    this.scheduleFlush(this.notesFileName(userId), { notes: [...this.notesFor(userId).values()] });
  }

  // Manifest per docs/sync.md: every known uid including tombstones; `deleted`
  // is omitted when false.
  manifest(userId) {
    return {
      notes: [...this.notesFor(userId).values()].map((n) => ({
        uid: n.uid,
        updatedAt: n.updatedAt,
        ...(n.deleted ? { deleted: true } : {}),
      })),
    };
  }
}

async function loadUsers(file) {
  const parsed = await readJsonFile(file, 'users.json');
  return new Map((parsed?.users ?? []).filter((u) => u?.sub).map((u) => [u.sub, u]));
}

async function loadClients(file) {
  const parsed = await readJsonFile(file, 'clients.json');
  return new Map((parsed?.clients ?? []).filter((c) => c?.client_id).map((c) => [c.client_id, c]));
}

async function loadNoteFiles(dataDir) {
  const out = new Map();
  let names = [];
  try {
    names = (await readdir(dataDir)).filter((f) => /^notes-.+\.json$/.test(f));
  } catch {
    return out;
  }
  for (const name of names) {
    const userId = name.slice('notes-'.length, -'.json'.length);
    const parsed = await readJsonFile(path.join(dataDir, name), name);
    out.set(userId, new Map((parsed?.notes ?? []).filter((n) => n?.uid).map((n) => [n.uid, n])));
  }
  return out;
}

async function readJsonFile(file, label) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null; // missing file → defaults
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[store] ${label} is corrupt; starting from defaults`);
    return null;
  }
}