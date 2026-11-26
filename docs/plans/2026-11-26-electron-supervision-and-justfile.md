# Electron Server Supervision and Justfile Implementation Plan

> **For the implementing agent:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Electron app restart its embedded server when it dies unexpectedly, and add a `justfile` that runs the app, the web target, and drives the kill/restart loop by hand.

**Architecture:** A pure `createRestartPolicy()` state machine in `electron/lifecycle.mjs` decides *whether* and *how long* to wait; `electron/main.mjs` owns the timer and calls the existing `startServer()`. `createServerExitHandler` gains a restart branch so an unexpected mid-session exit triggers a restart instead of quitting. The justfile resolves the project root (worktree or checkout) and kills the listener by port, not by process name.

**Tech Stack:** Node ESM (no build step for `electron/`), `node:test` for tests, Electron `utilityProcess`, `just` 1.49, `lsof`/`kill` (macOS + Linux).

---

## Design reference

`docs/plans/2026-11-26-electron-supervision-and-justfile-design.md`. Two invariants from it that every task must respect:

- **Never move ports.** A restart binds 4173 again. If it cannot, keep retrying — do not pick another port.
- **The initial start stays strict.** A failure to start at launch still shows "Note Haven could not start" and quits. Only an exit *after* a successful start is restartable.

---

### Task 1: Restart policy state machine

**Files:**
- Modify: `electron/lifecycle.mjs` (append)
- Test: `electron/test/lifecycle.test.mjs` (append)

**Step 1: Write the failing test**

Append to `electron/test/lifecycle.test.mjs`:

```js
describe('createRestartPolicy', () => {
  it('backs off further on each consecutive failure', () => {
    const policy = createRestartPolicy();
    assert.deepEqual([policy.nextDelay(), policy.nextDelay(), policy.nextDelay()], [250, 500, 750]);
  });

  it('caps the delay so a long outage still retries promptly', () => {
    const policy = createRestartPolicy();
    for (let i = 0; i < 100; i += 1) policy.nextDelay();
    assert.equal(policy.nextDelay(), 5000);
  });

  it('forgets previous failures once the server has been healthy', () => {
    const policy = createRestartPolicy();
    policy.nextDelay();
    policy.nextDelay();
    policy.recordHealthyUptime(10_000);
    assert.equal(policy.nextDelay(), 250);
  });

  it('keeps counting when the server died too soon to be healthy', () => {
    const policy = createRestartPolicy();
    policy.nextDelay();
    policy.recordHealthyUptime(1_000);
    assert.equal(policy.nextDelay(), 500);
  });

  it('never runs out of attempts', () => {
    const policy = createRestartPolicy();
    for (let i = 0; i < 1000; i += 1) {
      assert.equal(typeof policy.nextDelay(), 'number');
    }
  });
});
```

Add `createRestartPolicy` to the existing import at the top of that file.

**Step 2: Run test to verify it fails**

Run: `npm run test:electron`
Expected: FAIL — `createRestartPolicy is not a function` (or a SyntaxError on the import).

**Step 3: Write minimal implementation**

Append to `electron/lifecycle.mjs`:

```js
/**
 * How long to wait before restarting the server, and when to stop counting.
 *
 * There is no attempt limit on purpose: if the server ran once, the port was
 * free and the env was right, so a later exit is transient and retrying forever
 * is safe. The strict initial start in main.mjs is what stops an occupied port
 * from becoming a retry loop.
 */
export function createRestartPolicy({ baseDelayMs = 250, maxDelayMs = 5_000, healthyUptimeMs = 10_000 } = {}) {
  let attempt = 0;

  return {
    /** The delay to wait before the next attempt, in milliseconds. */
    nextDelay() {
      const delay = Math.min(baseDelayMs * (attempt + 1), maxDelayMs);
      attempt += 1;
      return delay;
    },
    /** Call when a server exits; a long uptime means this is a fresh incident. */
    recordHealthyUptime(uptimeMs) {
      if (uptimeMs >= healthyUptimeMs) attempt = 0;
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:electron`
Expected: PASS — all `createRestartPolicy` tests green, existing tests unchanged.

**Step 5: Commit**

```bash
git add electron/lifecycle.mjs electron/test/lifecycle.test.mjs
git commit -m "feat(electron): add a restart backoff policy"
```

---

### Task 2: Restart branch in the exit handler

**Files:**
- Modify: `electron/lifecycle.mjs` (`createServerExitHandler`)
- Test: `electron/test/lifecycle.test.mjs`

**Step 1: Write the failing test**

Append inside the existing `describe('createServerExitHandler')` block:

```js
  it('restarts instead of quitting when a restart is possible', () => {
    const dialogs = [];
    const quits = [];
    const restarts = [];
    const handle = createServerExitHandler({
      tracker: createShutdownTracker(),
      port: 4173,
      showErrorBox: (title, message) => dialogs.push({ title, message }),
      quit: () => quits.push('quit'),
      restart: () => restarts.push('restart'),
    });

    handle(1);

    assert.deepEqual(dialogs, []);
    assert.deepEqual(quits, []);
    assert.deepEqual(restarts, ['restart']);
  });

  it('falls back to the dialog when there is no restart available', () => {
    const { handle, dialogs, quits } = harness();
    handle(1);
    assert.equal(dialogs.length, 1);
    assert.deepEqual(quits, ['quit']);
  });

  it('still says nothing during an intentional quit, even with a restart available', () => {
    const dialogs = [];
    const restarts = [];
    const tracker = createShutdownTracker();
    const handle = createServerExitHandler({
      tracker,
      port: 4173,
      showErrorBox: (title, message) => dialogs.push({ title, message }),
      quit: () => {},
      restart: () => restarts.push('restart'),
    });
    tracker.begin();
    handle(15);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(restarts, []);
  });
```

**Step 2: Run test to verify it fails**

Run: `npm run test:electron`
Expected: FAIL — the handler calls `showErrorBox`/`quit` where the test expects `restart`.

**Step 3: Write minimal implementation**

Replace `createServerExitHandler` in `electron/lifecycle.mjs` with:

```js
export function createServerExitHandler({ tracker, port, showErrorBox, quit, restart }) {
  return function handleServerExit(code) {
    // Quitting kills the child, so its exit arrives even on a clean quit.
    // Only an exit the app did not ask for is worth reacting to.
    if (!tracker.shouldReportExit()) return;

    if (restart) {
      restart();
      return;
    }

    showErrorBox(
      'Note Haven stopped',
      `The embedded server exited (code ${code}). Port ${port} may be in use by another process.`,
    );
    quit();
  };
}
```

Keep the doc comment above it, updated to mention the restart branch.

**Step 4: Run test to verify it passes**

Run: `npm run test:electron`
Expected: PASS — all three new tests plus the pre-existing dialog tests.

**Step 5: Commit**

```bash
git add electron/lifecycle.mjs electron/test/lifecycle.test.mjs
git commit -m "feat(electron): let the exit handler restart rather than quit"
```

---

### Task 3: Supervise the server in main.mjs

**Files:**
- Modify: `electron/main.mjs`

**Step 1: Extract the start-and-watch wiring**

In `main.mjs`, replace the `try { serverProcess = await startServer(); ... }` block inside `app.whenReady()` with a call to a new function defined above `createWindow`:

```js
const restartPolicy = createRestartPolicy();
let serverStartedAt = 0;

async function launchServer() {
  serverProcess = await startServer();
  serverStartedAt = Date.now();

  const handleExit = createServerExitHandler({
    tracker: shutdown,
    port: PORT,
    showErrorBox: dialog.showErrorBox,
    quit: () => app.quit(),
    restart: () => void scheduleRestart(),
  });

  serverProcess.once('exit', (code) => {
    serverProcess = null;
    restartPolicy.recordHealthyUptime(Date.now() - serverStartedAt);
    handleExit(code);
  });
}

async function scheduleRestart() {
  const delay = restartPolicy.nextDelay();
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (shutdown.isShuttingDown()) return;

  try {
    await launchServer();
  } catch (error) {
    // Keep the port invariant: retry the same port rather than giving up.
    console.error('[main] server restart failed:', error.message);
    void scheduleRestart();
    return;
  }

  for (const window of BrowserWindow.getAllWindows()) window.reload();
}
```

Import `createRestartPolicy` alongside the existing lifecycle import.

**Step 2: Keep the initial start strict**

In `app.whenReady()`, the first `launchServer()` stays inside the existing `try/catch` so a launch-time failure still shows "Note Haven could not start" and quits:

```js
    if (!devUrl) {
      try {
        await launchServer();
      } catch (error) {
        dialog.showErrorBox('Note Haven could not start', [/* unchanged */].join('\n'));
        app.quit();
        return;
      }
    }
```

**Step 3: Verify it loads and the suite stays green**

Run: `node --check electron/main.mjs && npm run test:electron`
Expected: no syntax error; 30 tests pass (27 previous + 3 from Task 2).

**Step 4: Commit**

```bash
git add electron/main.mjs
git commit -m "feat(electron): restart the embedded server when it dies mid-session"
```

---

### Task 4: The justfile

**Files:**
- Create: `justfile`

**Step 1: Write the justfile**

```make
# Note Haven — run the app, the web target, and the checks.
#
# The Electron code lands on feat/electron-fork before main, so every Electron
# recipe resolves its root first: the worktree if it has electron/, else this
# checkout. After the branch merges, the second case takes over unchanged.

set shell := ["bash", "-euo", "pipefail", "-c"]

PORT := "4173"
ELECTRON_WORKTREE := ".worktrees/electron-fork"

# Print the directory that has electron/, or fail with a pointer to the branch.
_electron_root:
    @if [ -d "{{ELECTRON_WORKTREE}}/electron" ]; then echo "{{ELECTRON_WORKTREE}}"; \
    elif [ -d "electron" ]; then echo "."; \
    else echo "No electron/ here or in {{ELECTRON_WORKTREE}}." >&2; \
         echo "The Electron target lives on feat/electron-fork (PR #107)." >&2; exit 1; fi

# The web app's dev server on :8080.
web:
    npm run dev

# Build the renderer and launch the desktop app (fixed origin on :4173).
electron:
    cd "$(just _electron_root)" && npm run build:electron && npm run electron:start

# Start the desktop app against the current build, skipping the rebuild.
electron-start:
    cd "$(just _electron_root)" && npm run electron:start

# SIGKILL whatever holds the server port. That is the app's embedded server;
# it should come straight back.
kill-server:
    @pid="$(lsof -nP -iTCP:{{PORT}} -sTCP:LISTEN -t || true)"; \
    if [ -z "$pid" ]; then echo "nothing listening on {{PORT}}"; exit 0; fi; \
    echo "killing $pid"; kill -9 $pid

# Print the listening pid, or say nothing is there.
server-status:
    @pid="$(lsof -nP -iTCP:{{PORT}} -sTCP:LISTEN -t || true)"; \
    if [ -z "$pid" ]; then echo "not listening on {{PORT}}"; \
    else echo "listening on {{PORT}} (pid $pid)"; fi

# Poll the port every second so a restart is visible as a pid change.
watch-server:
    @last=""; \
    while true; do \
      pid="$(lsof -nP -iTCP:{{PORT}} -sTCP:LISTEN -t || true)"; \
      if [ "$pid" != "$last" ]; then \
        if [ -z "$pid" ]; then echo "$(date +%H:%M:%S)  not listening"; \
        else echo "$(date +%H:%M:%S)  listening (pid $pid)"; fi; \
        last="$pid"; \
      fi; \
      sleep 1; \
    done

# Tests (unit suite for the web app; electron/ has its own).
test:
    npm test
    cd "$(just _electron_root)" && npm run test:electron

lint:
    npm run lint

build:
    npm run build
```

**Step 2: Verify parsing and the pure-output recipes**

Run: `just --list`
Expected: every recipe listed, no parse error.

Run: `just server-status`
Expected: `listening on 4173 (pid …)` if the app is running, else `not listening on 4173`.

Run: `just kill-server` when nothing is listening
Expected: `nothing listening on 4173` and exit 0 (not an error).

**Step 3: Verify root resolution in both checkouts**

Run: `cd /Users/lewiscowles/Projects/personal/note-taking-app && just _electron_root`
Expected: `.worktrees/electron-fork`

Run: `cd .worktrees/electron-fork && just _electron_root`
Expected: `.`

**Step 4: Commit**

```bash
git add justfile
git commit -m "feat: add a justfile to run the app, web target and kill/restart loop"
```

---

### Task 5: Document the loop

**Files:**
- Modify: `docs/technical/electron.md` (the process-lifecycle section)

**Step 1: Update the lifecycle prose**

The current text says an exit after startup quits the app. Replace it with the supervised behaviour: unexpected exits restart on the same port, with backoff and no attempt limit, while a launch-time failure stays fatal. Add a short "Testing the restart" block with the recipe sequence from the design doc.

**Step 2: Verify**

Run: `grep -n "restart" docs/technical/electron.md`
Expected: the new prose is present and no stale "reports it and quits" claim remains for the mid-session case.

**Step 3: Commit**

```bash
git add docs/technical/electron.md
git commit -m "docs(electron): describe server supervision and the manual test loop"
```

---

### Task 6: Backport the justfile to main

**Files:**
- Create: `justfile` on a new branch off `main`

**Step 1: Create the branch**

```bash
cd /Users/lewiscowles/Projects/personal/note-taking-app
git worktree add .worktrees/justfile -b chore/justfile main
```

**Step 2: Copy the justfile and adjust for main**

`main` has no `electron/` anywhere, so the electron recipes will fail at
`_electron_root` with the PR #107 message — which is the intended behaviour. Keep
the recipes; do not strip them.

For `just test`, gate the Electron half so the backport does not fail on `main`:

```make
test:
    npm test
    @if [ -d "electron" ] || [ -d "{{ELECTRON_WORKTREE}}/electron" ]; then \
      cd "$(just _electron_root)" && npm run test:electron; \
    else echo "skipping electron tests: no electron/ on this branch"; fi
```

**Step 3: Verify**

Run: `just --list`
Expected: all recipes listed.

Run: `just test`
Expected: web tests run; electron half prints the skip message.

Run: `just electron`
Expected: fails with "The Electron target lives on feat/electron-fork (PR #107)."

**Step 4: Commit**

```bash
git add justfile
git commit -m "chore: add a justfile for the web target and the desktop loop"
```

---

## Verification checklist

- [ ] `npm run test:electron` — all tests pass, including policy and restart-branch coverage
- [ ] `npm run lint` — no new warnings from `electron/`
- [ ] `just --list` — parses in both worktrees
- [ ] `just kill-server` — exits 0 when nothing is listening
- [ ] Manual: `just electron`, `just server-status`, `just kill-server`, `just server-status` shows a **different pid**
- [ ] Manual: Cmd+Q from the app shows no dialog
- [ ] Manual: hold 4173 with `python3 -m http.server 4173`, launch the app → "could not start" dialog (initial start still strict)
