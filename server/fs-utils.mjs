// Atomic file-write helpers (write to a temp file, then rename over the
// target) shared by the storage layer. Renames within the same directory are
// atomic on POSIX, so a crash mid-write never leaves a torn JSON file behind.
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}

export async function writeAtomic(filePath, data) {
  await mkdirp(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function writeAtomicSync(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
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