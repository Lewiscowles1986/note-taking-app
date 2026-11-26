# Electron server supervision and a justfile — design

Date: 2026-11-26
Branch: `feat/electron-fork` (supervision), plus a `justfile`-only branch off `main`
Status: approved

## The problem

The embedded server on port 4173 is the renderer's origin, so it is not an
incidental background process: if it stops, every note is unreachable. Today an
exit after startup is treated as fatal — `main.mjs` shows "Note Haven stopped"
and quits.

That is correct for a crash you cannot recover from, and it was the right
default when the target was a spike. It is wrong for the case that actually
happens while developing: something kills the server, and there is no reason the
app could not simply start it again. There is also no convenient way to *drive*
that scenario by hand, which is why the previous fix could only be verified by
tests rather than by using the app.

Two deliverables:

1. The app restarts the embedded server when it dies unexpectedly.
2. A `justfile` that makes the whole loop — run the app, kill the server, watch
   it come back — a single command, and also runs the web target.

## Decision: supervision, not a supervisor process

The restart lives in the main process, not in an external wrapper.

An external supervisor (`just` looping `electron .`) cannot work: killing the
server does not exit the app, so there is nothing for the wrapper to notice, and
restarting the *app* would destroy the windows, the single-instance lock and any
in-memory renderer state while leaving IndexedDB untouched — a much bigger
hammer than the problem needs.

The main process already owns the child's lifetime (`utilityProcess.fork`,
`before-quit`). Supervision is a few lines there and needs no new dependency.

## What restarts, and what does not

The distinction is *when* the exit happens, not what the exit code was.

| Exit | Behaviour |
| --- | --- |
| Initial start fails (`EADDRINUSE`, missing root, timeout) | **Unchanged**: "Note Haven could not start" dialog, then quit |
| Server exits *after* a successful start, app still running | **Restart** on the same port, forever |
| Exit during quit (`before-quit` already ran) | **Ignored** — the app is going away |

Keeping the initial failure strict is what stops "unlimited restarts" from
becoming an infinite retry loop against a port that something else holds. If the
app got as far as a working server once, the port was free and the app's own
env was correct; a later exit is transient by nature, so retrying indefinitely is
safe. If it never started, retrying would only delay a dialog that already
explains the problem.

## Backoff

Retries are immediate-ish but not hot: `min(250ms × attempt, 5s)`. The delay
exists so a server that dies instantly on every start does not spin the CPU; the
cap keeps recovery from a one-off kill imperceptible. The attempt counter resets
once the server has been up for 10 seconds, so a crash an hour apart is treated
as a fresh event rather than attempt number fifty.

No maximum: per the approved decision, a mid-session kill always recovers.

## Window handling

After a successful restart the window is reloaded. A renderer that was mid-fetch
when the server died is otherwise left showing failed requests against a server
that is now healthy, which reads as "still broken". Reloading re-runs the app's
normal startup against the same origin, so nothing is lost — the state that
matters is in IndexedDB.

A failed restart reloads nothing; the retry loop continues and the window shows
the failure until one succeeds.

## Where the code goes

Following the existing shape — Electron-free modules, tested by
`npm run test:electron` in plain Node:

```
electron/lifecycle.mjs     ++ createRestartPolicy()   when to try again, how long to wait
electron/lifecycle.mjs     ++ createServerExitHandler() gains a restart branch
electron/main.mjs          wires policy → startServer() → window.reload()
```

`createRestartPolicy()` is a state machine with no timers of its own:
`nextDelay()` returns the delay to wait before retrying, and `recordHealthyUptime(ms)`
resets the counter. main.mjs owns the `setTimeout`. That keeps the interesting
part (the decisions) testable without fake clocks or Electron.

## The justfile

Committed twice: on `feat/electron-fork` alongside the supervision change, and
`justfile`-only on a branch off `main`.

### Recipes

| Recipe | What it does |
| --- | --- |
| `just web` | Vite dev server on :8080 |
| `just electron` | Build the renderer, then launch the app (fixed renderer, real origin) |
| `just kill-server` | SIGKILL whatever listens on 4173 — the exact thing that must now self-heal |
| `just server-status` | Print the current listener's PID, or say nothing is listening |
| `just watch-server` | Poll the listener every second, printing PID changes |
| `just test` / `just lint` / `just build` | The corresponding npm scripts |

### Resolving the project root

The Electron code is not on `main`, so a recipe that hardcodes the checkout would
be wrong in one place or the other. Each Electron recipe resolves its root as:

1. `.worktrees/electron-fork` if it contains `electron/`, else
2. the current directory, if it contains `electron/`, else
3. fail with a message naming PR #107.

After the branch merges, case 2 takes over with no edit. Before it merges, case 1
makes the recipes work from the main checkout.

### Why kill by port, not by name

`kill-server` resolves the pid with `lsof -nP -iTCP:4173 -sTCP:LISTEN -t`.
Matching on a process name would miss whichever of the app, a packaged build, or
an orphaned `electron-serve.mjs` is actually holding the port — and that last one
is precisely the case the parent-watch fix addresses. Port identity is also the
thing that actually matters here: 4173 is the note store's origin.

### Verifying the fix by hand

```
just electron          # terminal 1: app launches, server listens on 4173
just server-status     # note the pid
just kill-server       # terminal 2
just server-status     # a *different* pid — the app rebooted the server
```

`just watch-server` in a second terminal makes the pid change visible as it
happens.

## Testing

- `npm run test:electron` covers `createRestartPolicy` (delay growth, cap, reset
  on healthy uptime, no restart while shutting down) and the extended
  `createServerExitHandler` (restart branch vs dialog branch).
- The existing `server-process.test.mjs` integration test already proves the port
  is released when the parent dies; the restart path is covered by spawning a
  real server and killing it.
- Manual verification per the recipe sequence above, since the GUI cannot be
  driven in the agent sandbox (Electron SIGTRAPs there).

## Rejected alternatives

- **External supervisor wrapper** — cannot see an in-app server death, and
  restarting the whole app is disproportionate. See above.
- **A budget of N restarts** — rejected by the user; a mid-session kill should
  always recover. The strict initial start provides the safety the budget would
  have.
- **Switching ports on collision** — never. A different port is a different,
  empty note store; this is the one non-negotiable in the existing design.
- **A `just` recipe that pokes the app's IPC to restart the server** — no such
  channel exists, and adding one for a dev convenience is not worth it when
  killing the process tests the real path anyway.
