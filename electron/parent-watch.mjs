/**
 * Exits the embedded server when the app that owns it disappears.
 *
 * `utilityProcess` children are not reaped by the OS when the main process dies
 * without running its quit path — a Force Quit or a crash. The orphan keeps
 * listening on the fixed port, and because that port is the app's identity
 * (IndexedDB is keyed by origin) the next launch cannot take it. So the child
 * watches the parent it was started under and closes itself when it goes away.
 *
 * No Electron imports: `npm run test:electron` drives this in plain Node.
 */
export function currentParentPid() {
  return process.ppid;
}

/** True while `pid` is a process we can signal. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to someone else —
    // still alive, and not ours to worry about.
    return error?.code === 'EPERM';
  }
}

/**
 * Call `onParentGone` once the spawning process is gone.
 * Returns a function that stops watching.
 */
export function watchParent({
  pid = currentParentPid(),
  intervalMs = 500,
  checkAlive = isAlive,
  onParentGone,
} = {}) {
  // pid 1 (or an id we cannot read) means there is no parent to watch — that is
  // a terminal run, not an orphan. Watching it would exit us immediately.
  if (!Number.isInteger(pid) || pid <= 1) return () => {};

  const timer = setInterval(() => {
    if (checkAlive(pid)) return;
    clearInterval(timer);
    onParentGone();
  }, intervalMs);

  // Never keep the process alive just for the watchdog.
  timer.unref?.();
  return () => clearInterval(timer);
}
