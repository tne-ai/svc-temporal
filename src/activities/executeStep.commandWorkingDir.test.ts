import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCommandWorkingDir } from './executeStep.js';

const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'svc-temporal-command-dir-test-'));
  roots.push(root);
  return root;
}

function makeTnePlugins(root: string, skillName = 'p-cpo12-build-compass-application'): string {
  const pluginsRoot = join(root, 'bundled-tne-plugins');
  const skillDir = join(pluginsRoot, 'plugins', 'tne', 'skills', skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'build_compass_application.py'), 'print("ok")\n');
  return pluginsRoot;
}

afterEach(() => {
  delete process.env.TNE_PLUGINS_PATH;
  delete process.env.SVC_TEMPORAL_DISABLE_TNE_PLUGINS_CLONE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ensureCommandWorkingDir', () => {
  it('creates a missing workspace workingDir and seeds bundled tne-plugins', () => {
    const root = tmpRoot();
    const bundled = makeTnePlugins(root);
    process.env.TNE_PLUGINS_PATH = bundled;

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'tne-plugins');
    ensureCommandWorkingDir(
      workspace,
      'tne-plugins',
      cwdRoot,
      'python3 plugins/tne/skills/p-cpo12-build-compass-application/build_compass_application.py',
    );

    expect(existsSync(join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo12-build-compass-application', 'build_compass_application.py'))).toBe(true);
  });

  it('does not accept a stale bundled plugin tree when the command requires a missing script', () => {
    const root = tmpRoot();
    const stale = makeTnePlugins(root, 'p-cpo10-build-compass-app');
    process.env.TNE_PLUGINS_PATH = stale;
    process.env.SVC_TEMPORAL_DISABLE_TNE_PLUGINS_CLONE = 'true';

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'tne-plugins');
    ensureCommandWorkingDir(
      workspace,
      'tne-plugins',
      cwdRoot,
      'python3 plugins/tne/skills/p-cpo12-build-compass-application/build_compass_application.py',
    );

    expect(existsSync(join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo12-build-compass-application', 'build_compass_application.py'))).toBe(false);
    expect(existsSync(join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo10-build-compass-app', 'build_compass_application.py'))).toBe(true);
  });
});
