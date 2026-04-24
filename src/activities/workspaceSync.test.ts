import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { wipeWorkspace } from './workspaceSync.js';

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'wipe-')); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

describe('wipeWorkspace', () => {
  it('removes everything under localPath when no scopePath is given', async () => {
    mkdirSync(join(tmpRoot, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(tmpRoot, 'a.txt'), 'a');
    writeFileSync(join(tmpRoot, 'nested', 'b.txt'), 'b');

    const res = await wipeWorkspace({ localPath: tmpRoot });

    expect(res.existed).toBe(true);
    expect(existsSync(tmpRoot)).toBe(false);
  });

  it('removes only the scoped subdirectory', async () => {
    mkdirSync(join(tmpRoot, 'keep'), { recursive: true });
    mkdirSync(join(tmpRoot, 'wipe', 'deep'), { recursive: true });
    writeFileSync(join(tmpRoot, 'keep', 'a.txt'), 'a');
    writeFileSync(join(tmpRoot, 'wipe', 'b.txt'), 'b');
    writeFileSync(join(tmpRoot, 'wipe', 'deep', 'c.txt'), 'c');

    await wipeWorkspace({ localPath: tmpRoot, scopePath: 'wipe' });

    expect(existsSync(join(tmpRoot, 'keep', 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpRoot, 'wipe'))).toBe(false);
  });

  it('is a no-op when the target does not exist', async () => {
    const res = await wipeWorkspace({
      localPath: tmpRoot,
      scopePath: 'does/not/exist',
    });
    expect(res.existed).toBe(false);
  });

  it('refuses absolute scopePath', async () => {
    await expect(
      wipeWorkspace({ localPath: tmpRoot, scopePath: '/etc' }),
    ).rejects.toThrow(/unsafe scopePath/);
  });

  it('refuses scopePath that escapes localPath', async () => {
    await expect(
      wipeWorkspace({ localPath: tmpRoot, scopePath: '../foo' }),
    ).rejects.toThrow(/unsafe scopePath/);
  });
});
