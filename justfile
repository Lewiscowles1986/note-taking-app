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

# Tests: web unit suite, then the electron suite from wherever electron/ lives.
test:
    npm test
    cd "$(just _electron_root)" && npm run test:electron

lint:
    npm run lint

build:
    npm run build
