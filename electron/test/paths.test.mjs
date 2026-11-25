import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRendererRoot } from '../paths.mjs';

describe('resolveRendererRoot', () => {
  it('reads the built renderer from inside the app bundle when packaged', () => {
    const root = resolveRendererRoot({
      isPackaged: true,
      appPath: path.join('/Applications', 'Note Haven.app', 'Contents', 'Resources', 'app.asar'),
      moduleDir: '/ignored',
    });
    assert.equal(
      root,
      path.join('/Applications', 'Note Haven.app', 'Contents', 'Resources', 'app.asar', 'dist-electron'),
    );
  });

  it('reads the worktree build when running from source', () => {
    const root = resolveRendererRoot({
      isPackaged: false,
      appPath: '/ignored',
      moduleDir: '/repo/electron',
    });
    assert.equal(root, path.resolve('/repo', 'dist-electron'));
  });
});
