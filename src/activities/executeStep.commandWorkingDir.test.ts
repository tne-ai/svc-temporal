import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCommandWorkingDir, resolveSharedCommand } from './executeStep.js';

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

let savedCwd: string | undefined;
afterEach(() => {
  delete process.env.TNE_PLUGINS_PATH;
  delete process.env.SVC_TEMPORAL_DISABLE_TNE_PLUGINS_CLONE;
  if (savedCwd) { process.chdir(savedCwd); savedCwd = undefined; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ensureCommandWorkingDir', () => {
  const CMD =
    'python3 plugins/tne/skills/p-cpo12-build-compass-application/build_compass_application.py';
  const sharedScript = (bundled: string) =>
    join(bundled, 'plugins', 'tne', 'skills', 'p-cpo12-build-compass-application', 'build_compass_application.py');

  it('with a container tne-plugins, runs the script from there WITHOUT copying it into the project', () => {
    // Single-source model: tne-plugins is per-container infrastructure. The project
    // workspace must NOT receive a plugins/ copy; the command is rewritten to run
    // the script straight from the container checkout (TNE_PLUGINS_PATH).
    const root = tmpRoot();
    const bundled = makeTnePlugins(root);
    process.env.TNE_PLUGINS_PATH = bundled;

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'tne-plugins');
    ensureCommandWorkingDir(workspace, 'tne-plugins', cwdRoot, CMD);

    expect(existsSync(join(cwdRoot, 'plugins'))).toBe(false); // no per-project copy
    expect(resolveSharedCommand(CMD)).toContain(sharedScript(bundled));
  });

  it('resolves the shared script regardless of workingDir name (e.g. chat workingDir "Compass")', () => {
    const root = tmpRoot();
    const bundled = makeTnePlugins(root);
    process.env.TNE_PLUGINS_PATH = bundled;

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'Compass'); // workingDir = "Compass", NOT tne-plugins
    ensureCommandWorkingDir(workspace, 'Compass', cwdRoot, CMD);

    expect(existsSync(join(cwdRoot, 'plugins'))).toBe(false);
    expect(resolveSharedCommand(CMD)).toContain(sharedScript(bundled));
  });

  it('does nothing for a command that is not a tne-plugins script', () => {
    const root = tmpRoot();
    const bundled = makeTnePlugins(root);
    process.env.TNE_PLUGINS_PATH = bundled;
    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'Compass');
    ensureCommandWorkingDir(workspace, 'Compass', cwdRoot, 'python3 scripts/build.py');
    // No plugins/ overlaid — the command does not reference plugins/tne/...
    expect(existsSync(join(cwdRoot, 'plugins'))).toBe(false);
  });

  it('ignores a stale workspace checkout — the rewritten command runs the fresh container script', () => {
    // Pre-single-source, a stale plugins/ copy in the workspace could shadow the
    // deployed code (the app-foundry "missing default.yaml" bug). Now the command
    // always runs from the container checkout, so a stale workspace copy is never used.
    const root = tmpRoot();
    const bundled = makeTnePlugins(root);
    process.env.TNE_PLUGINS_PATH = bundled;

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'tne-plugins');
    const staleSkill = join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo12-build-compass-application');
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(join(staleSkill, 'build_compass_application.py'), 'print("stale")\n');

    ensureCommandWorkingDir(workspace, 'tne-plugins', cwdRoot, CMD);

    const resolved = resolveSharedCommand(CMD);
    expect(resolved).toContain(sharedScript(bundled)); // fresh container script
    expect(resolved).not.toContain(cwdRoot); // not the stale workspace copy
  });

  it('throws (fails loud) when the only bundle is stale and clone is disabled', () => {
    const root = tmpRoot();
    const stale = makeTnePlugins(root, 'p-cpo10-build-compass-app'); // lacks the required p-cpo12 script
    process.env.TNE_PLUGINS_PATH = stale;
    process.env.SVC_TEMPORAL_DISABLE_TNE_PLUGINS_CLONE = 'true';
    // Isolate from the repo's real tne-plugins submodule (which findBundledTnePluginsRoot
    // would otherwise discover at process.cwd()/tne-plugins) so the only bundle is the stale fixture.
    savedCwd = process.cwd();
    process.chdir(root);

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'tne-plugins');
    // The required p-cpo12 script can't be obtained from the stale bundle and clone is
    // disabled — preparation must fail loudly rather than silently proceed without it.
    expect(() =>
      ensureCommandWorkingDir(
        workspace,
        'tne-plugins',
        cwdRoot,
        'python3 plugins/tne/skills/p-cpo12-build-compass-application/build_compass_application.py',
      ),
    ).toThrow(/Unable to prepare tne-plugins/);
  });
});
