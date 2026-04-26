import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { wipeWorkspace, shouldExclude } from './workspaceSync.js';

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

describe('shouldExclude', () => {
  // Locks in the multi-segment fix. Before, '.claude/skills' silently never
  // matched because shouldExclude only did `segments.includes(pattern)` and
  // a literal containing '/' is never a single segment — so all ~2k skill
  // files were swept into every periodic push, and concurrent workers
  // racing on those files were the real source of .temporal-<ts> backups.
  it('excludes single-segment directory names', () => {
    expect(shouldExclude('node_modules/lodash/index.js')).toBe(true);
    expect(shouldExclude('foo/.git/config')).toBe(true);
  });

  it('excludes multi-segment path-prefix patterns', () => {
    expect(shouldExclude('.claude/skills/p-debug1/SKILL.md')).toBe(true);
    expect(shouldExclude('.claude/projects/-tmp-x/log.jsonl')).toBe(true);
    expect(shouldExclude('.claude/EBP/.local/bin/fsm-start')).toBe(true);
    expect(shouldExclude('.claude/debug/whatever.txt')).toBe(true);
  });

  it('excludes the multi-segment directory itself, not just descendants', () => {
    expect(shouldExclude('.claude/skills')).toBe(true);
  });

  it('excludes glob patterns by filename', () => {
    expect(shouldExclude('logs/server.log')).toBe(true);
    expect(shouldExclude('foo/bar.txt.temporal-1234567890')).toBe(true);
  });

  it('does not exclude .claude itself or unrelated children', () => {
    expect(shouldExclude('.claude/CLAUDE.md')).toBe(false);
    expect(shouldExclude('.claude/settings.json')).toBe(false);
  });

  it('does not over-exclude paths that merely share a prefix', () => {
    expect(shouldExclude('.claude/skills-archive/old.md')).toBe(false);
    expect(shouldExclude('.claude/projectsx/file.md')).toBe(false);
  });
});
