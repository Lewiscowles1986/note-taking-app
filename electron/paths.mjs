import path from 'node:path';

/**
 * Where the built renderer lives. Packaged, it sits inside app.asar next to
 * this module; in a checkout it is the worktree's `dist-electron/`.
 * `app.asar` is readable by Electron's patched `fs`, so no unpacking needed.
 */
export function resolveRendererRoot({ isPackaged, appPath, moduleDir }) {
  return isPackaged
    ? path.join(appPath, 'dist-electron')
    : path.resolve(moduleDir, '..', 'dist-electron');
}
