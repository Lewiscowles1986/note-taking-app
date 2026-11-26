/**
 * Decides whether a server exit is news.
 *
 * Every intentional quit kills the child, and the child's `exit` event is
 * indistinguishable from a crash once it arrives. So the decision is made from
 * what the app intended, not from the exit code: if `before-quit` already asked
 * the server to stop, or the exit has been reported once, the dialog is noise.
 *
 * Kept free of Electron imports so `npm run test:electron` covers it in plain
 * Node.
 */
export function createShutdownTracker() {
  let shuttingDown = false;
  let reported = false;

  return {
    /** Record that the app is quitting on purpose. */
    begin() {
      shuttingDown = true;
    },
    isShuttingDown() {
      return shuttingDown;
    },
    /** True exactly when the exit deserves a dialog. */
    shouldReportExit() {
      if (shuttingDown || reported) return false;
      reported = true;
      return true;
    },
  };
}

/**
 * The `exit` handler for the forked server, kept out of main.mjs so the
 * decision — restart, dialog, or silence — is covered by `npm run test:electron`.
 *
 * `onUnexpectedExit` must set `serverProcess = null` itself; this only decides
 * what happens next. When `restart` is supplied an unexpected exit is treated as
 * recoverable; without it the exit is terminal and the user is told.
 */
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
