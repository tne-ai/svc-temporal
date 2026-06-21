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

let savedCwd: string | undefined;
afterEach(() => {
  delete process.env.TNE_PLUGINS_PATH;
  delete process.env.SVC_TEMPORAL_DISABLE_TNE_PLUGINS_CLONE;
  if (savedCwd) { process.chdir(savedCwd); savedCwd = undefined; }
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

  it('prepares tne-plugins even when workingDir is NOT tne-plugins (e.g. chat workingDir "Compass")', () => {
    // The app-foundry fail loop: the run is launched with the chat's workingDir
    // ("Compass"), not "tne-plugins". The overlay must still fire — driven by the
    // command's plugins/tne/... script — so cwd=<workspace>/Compass gets a plugins/
    // dir and the generator command can find its script.
    const root = tmpRoot();
    const bundled = makeTnePlugins(root);
    process.env.TNE_PLUGINS_PATH = bundled;

    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'Compass'); // workingDir = "Compass", NOT tne-plugins
    ensureCommandWorkingDir(
      workspace,
      'Compass',
      cwdRoot,
      'python3 plugins/tne/skills/p-cpo12-build-compass-application/build_compass_application.py',
    );

    expect(existsSync(join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo12-build-compass-application', 'build_compass_application.py'))).toBe(true);
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

  it('refreshes a stale workspace checkout (script present, contracts stale) from the deployed bundle', () => {
    const root = tmpRoot();
    // Deployed/bundled tne-plugins: has p-cpo12 script AND the generic default.yaml contract.
    const bundled = makeTnePlugins(root);
    const bundledContracts = join(bundled, 'plugins', 'tne', 'skills', 'p-cpo11-compose-app', 'contracts');
    mkdirSync(bundledContracts, { recursive: true });
    writeFileSync(join(bundledContracts, 'crm.yaml'), 'label: CRM\n');
    writeFileSync(join(bundledContracts, 'default.yaml'), 'label: Application\n');
    process.env.TNE_PLUGINS_PATH = bundled;

    // Stale workspace checkout: the command's script is already present, but the
    // contracts dir predates default.yaml (only crm.yaml) — the app-foundry failure.
    const workspace = join(root, 'workspace');
    const cwdRoot = join(workspace, 'tne-plugins');
    const staleSkill = join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo12-build-compass-application');
    mkdirSync(staleSkill, { recursive: true });
    writeFileSync(join(staleSkill, 'build_compass_application.py'), 'print("stale")\n');
    const staleContracts = join(cwdRoot, 'plugins', 'tne', 'skills', 'p-cpo11-compose-app', 'contracts');
    mkdirSync(staleContracts, { recursive: true });
    writeFileSync(join(staleContracts, 'crm.yaml'), 'label: CRM\n');

    ensureCommandWorkingDir(
      workspace,
      'tne-plugins',
      cwdRoot,
      'python3 plugins/tne/skills/p-cpo12-build-compass-application/build_compass_application.py',
    );

    // The generic default.yaml from the deployed bundle must now be present, so a
    // non-CRM app domain composes instead of crashing on a missing contract pack.
    expect(existsSync(join(staleContracts, 'default.yaml'))).toBe(true);
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
