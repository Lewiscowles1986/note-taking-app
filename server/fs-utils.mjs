// Atomic file-write helpers (write to a temp file, then rename over the
// target) shared by the storage layer. Renames within the same directory are
// atomic on POSIX, so a crash mid-write never leaves a torn JSON file behind.
// `mode` is applied to the temp file BEFORE the rename so the final file
// carries it (rename preserves the source's permissions) — used to keep
// secrets like keys.json at 0600.
import { mkdir, rename, unlink, writeFile, chmod } from 'node:fs/promises';
import { closeSync, chmodSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}

export async function writeAtomic(filePath, data, { mode = 0o644 } = {}) {
  await mkdirp(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode); // in case the fs pre-existed tmp with different bits
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function writeAtomicSync(filePath, data, { mode = 0o644 } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, mode); // umask can mask bits on open(); enforce before rename
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}