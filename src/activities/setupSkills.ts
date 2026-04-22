/**
 * Skill filesystem setup for the agent's cwd.
 *
 * The Claude Agent SDK resolves `.claude/skills/<name>/SKILL.md` relative to
 * its cwd — not via any configurable plugin path. When svc-temporal runs an
 * agent in a freshly-pulled (or S3-excluded) workspace, that directory is
 * missing, so `Skill(name=...)` invocations silently fall back to improvised
 * behavior. This helper populates it with symlinks to tne-plugins so the
 * agent can discover every plugin skill.
 *
 * Mirrors horizon's `copyFsmEngineToWorkspace` (backend/src/services/agentService.ts),
 * minus the per-user RBAC filtering — svc-temporal currently surfaces all
 * plugin skills.
 */
import { existsSync } from 'fs';
import { mkdir, readlink, readdir, rm, symlink } from 'fs/promises';
import { join } from 'path';

/** Candidate locations for the tne-plugins repo on the worker machine. */
function findTnePluginsRoot(): string | null {
  const candidates = [
    process.env.TNE_PLUGINS_PATH,
    join(process.cwd(), '..', 'tne-plugins'),
    join(process.cwd(), 'tne-plugins'),
    '/app/tne-plugins',
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(join(p, 'plugins', 'tne', 'skills'))) return p;
  }
  return null;
}

/** Replace the target with a symlink to `src`, but only if not already correct.
 *
 *  Race-safe for concurrent callers: parallel activities in the same workspace
 *  will all try to set up the same symlinks simultaneously. The fast-path
 *  short-circuit lets every caller exit once the link is correct, and the
 *  EEXIST catch handles the window where one caller's rm → symlink pair
 *  interleaves with another's. */
async function ensureSymlink(src: string, dst: string): Promise<void> {
  if ((await readlink(dst).catch(() => null)) === src) return;
  await rm(dst, { recursive: true, force: true }).catch(() => {});
  try {
    await symlink(src, dst);
  } catch (err: any) {
    if (err?.code === 'EEXIST' && (await readlink(dst).catch(() => null)) === src) return;
    throw err;
  }
}

/**
 * Ensure `<workspacePath>/.claude/{skills,plugins/tne/{engine,skills}}` exist
 * and are populated with symlinks into tne-plugins. Safe to call repeatedly —
 * each symlink is refreshed only when its target has drifted.
 *
 * Populates both `.claude/skills/<name>` (legacy lookup path used by the
 * Claude Agent SDK) and `.claude/plugins/tne/skills/<name>` (the path used by
 * SKILL.md `find ~/.claude/plugins` commands).
 */
export async function ensureSkillsInWorkspace(workspacePath: string): Promise<void> {
  const pluginsRoot = findTnePluginsRoot();
  if (!pluginsRoot) {
    console.warn('[ensureSkillsInWorkspace] tne-plugins not found — set TNE_PLUGINS_PATH');
    return;
  }

  const pluginsBase = join(workspacePath, '.claude', 'plugins', 'tne');
  const skillsDst = join(pluginsBase, 'skills');
  const legacySkillsDst = join(workspacePath, '.claude', 'skills');
  await mkdir(pluginsBase, { recursive: true });
  await mkdir(skillsDst, { recursive: true });
  await mkdir(legacySkillsDst, { recursive: true });

  // Engine symlink — some SKILL.md recipes do `find ~/.claude/plugins -type d -path "*/tne/engine"`.
  const engineSrc = join(pluginsRoot, 'plugins', 'tne', 'engine');
  if (existsSync(engineSrc)) {
    await ensureSymlink(engineSrc, join(pluginsBase, 'engine'));
  }

  // Iterate every plugin bundle (tne, bjarne, …) and surface each skill dir.
  const bundleRoot = join(pluginsRoot, 'plugins');
  const bundles = await readdir(bundleRoot, { withFileTypes: true });
  for (const bundle of bundles) {
    if (!bundle.isDirectory()) continue;
    const bundleSkillsDir = join(bundleRoot, bundle.name, 'skills');
    if (!existsSync(bundleSkillsDir)) continue;
    const entries = await readdir(bundleSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = join(bundleSkillsDir, entry.name);
      await ensureSymlink(src, join(skillsDst, entry.name));
      await ensureSymlink(src, join(legacySkillsDst, entry.name));
    }
  }
}

