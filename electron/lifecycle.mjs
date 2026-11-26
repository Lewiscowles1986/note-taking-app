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
 * decision — dialog or silence — is covered by `npm run test:electron`.
 *
 * `onUnexpectedExit` must set `serverProcess = null` itself; this only decides
 * whether the user hears about it.
 */
export function createServerExitHandler({ tracker, port, showErrorBox, quit }) {
  return function handleServerExit(code) {
    // Quitting kills the child, so its exit arrives even on a clean quit.
    // Only an exit the app did not ask for is worth a dialog.
    if (!tracker.shouldReportExit()) return;
    showErrorBox(
      'Note Haven stopped',
      `The embedded server exited (code ${code}). Port ${port} may be in use by another process.`,
    );
    quit();
  };
}
