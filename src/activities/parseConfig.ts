/**
 * parseConfig activity — resolves a skill name to a SKILL.md path
 * and parses it into a ProcessConfig.
 *
 * Skill resolution order:
 * 1. Horizon DB via HTTP: fetched from /api/fsm-invoke/skill/:name and
 *    cached to a temp dir. Authoritative — orion keeps the DB current via
 *    `yarn sync-skills` against tne-plugins main, so it always matches the
 *    canonical SOP format.
 * 2. User's workspace: {workspacePath}/.claude/skills/{skillName}/SKILL.md.
 *    Fallback for workflows that run offline or for user-authored skills
 *    that haven't been synced to the DB yet.
 * 3. tne-plugins repo: {tnePluginsRoot}/plugins/tne/skills/{skillName}/SKILL.md.
 *    Last resort — the submodule shipped with the worker image can lag behind
 *    the DB.
 *
 * Why DB-first (changed 2026-04-24): the user workspace is a cache of S3,
 * and S3 can carry half-migrated skill files while the DB (populated from
 * tne-plugins main via sync-skills) has the clean canonical version.
 * Observed with p-ceo1-manage-strategy: S3 had a stub `## SOP` body block
 * plus a stale `sop:` frontmatter, the parser fell through to the frontmatter
 * and executed the wrong SOP.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseSkillFile } from '../config/skillParser.js';
import type { ProcessConfig } from '../shared/types.js';
import { FSM_INVOKE_SECRET, HORIZON_FSM_BASE } from '../shared/constants.js';

// ─── Skill Path Resolution ─────────────────────────────────────────────────

/**
 * Candidate paths to find the tne-plugins repo on the worker machine.
 * In production this would be a mounted volume or configurable env var.
 */
function getTnePluginsRoot(): string | null {
  const candidates = [
    process.env.TNE_PLUGINS_PATH,
    join(process.cwd(), '..', 'tne-plugins'),
    join(process.cwd(), 'tne-plugins'),
    '/app/tne-plugins',
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(join(p, 'plugins'))) return p;
  }
  return null;
}

/**
 * Resolve a skill name to a SKILL.md file path from local sources only
 * (workspace, then tne-plugins submodule). Used as a fallback when the
 * Horizon DB fetch is unavailable or returns 404.
 */
function resolveSkillPathLocal(skillName: string, workspacePath: string): string | null {
  // 1. User's workspace — check workspacePath and up to 2 parent dirs
  let check = workspacePath;
  for (let i = 0; i < 3; i++) {
    const wsSkill = join(check, '.claude', 'skills', skillName, 'SKILL.md');
    if (existsSync(wsSkill)) return wsSkill;
    const parent = resolve(check, '..');
    if (parent === check) break;
    check = parent;
  }

  // 2. tne-plugins repository — search across all plugin namespaces.
  //    Originally hardcoded to plugins/tne/skills/; broken for plugins like
  //    jpm/ that live in their own namespace. Now iterates over all plugins.
  const root = getTnePluginsRoot();
  if (root) {
    const pluginsDir = join(root, 'plugins');
    try {
      const plugins = readdirSync(pluginsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
      for (const plugin of plugins) {
        const pluginSkill = join(pluginsDir, plugin, 'skills', skillName, 'SKILL.md');
        if (existsSync(pluginSkill)) return pluginSkill;
      }
    } catch {
      // pluginsDir unreadable — fall through to null
    }
  }

  return null;
}

/**
 * Fetch SKILL.md content from Horizon's DB via the internal fsm-invoke endpoint
 * and cache it on disk at {tmp}/svc-temporal-skills/{skillName}/SKILL.md.
 * Returns the cached path, or null if the endpoint isn't configured / skill
 * isn't in the DB.
 *
 * This is the fallback for when tne-plugins baked into the worker image lags
 * behind the DB — without it, parseConfig throws "SKILL.md not found" even
 * though orion knows about the skill.
 */
async function fetchSkillFromHorizon(skillName: string): Promise<string | null> {
  if (!HORIZON_FSM_BASE || !FSM_INVOKE_SECRET) return null;
  const url = `${HORIZON_FSM_BASE}/skill/${encodeURIComponent(skillName)}`;
  try {
    const response = await fetch(url, {
      headers: { 'x-fsm-secret': FSM_INVOKE_SECRET },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`[parseConfig] Horizon skill fetch failed (${response.status}) for ${skillName}`);
      return null;
    }
    const content = await response.text();
    const cacheDir = join(tmpdir(), 'svc-temporal-skills', skillName);
    mkdirSync(cacheDir, { recursive: true });
    const cachedPath = join(cacheDir, 'SKILL.md');
    writeFileSync(cachedPath, content, 'utf-8');
    console.log(`[parseConfig] Cached ${skillName} from Horizon DB → ${cachedPath}`);
    return cachedPath;
  } catch (err: any) {
    console.warn(`[parseConfig] Horizon skill fetch errored for ${skillName}: ${err.message}`);
    return null;
  }
}

// ─── Activity ───────────────────────────────────────────────────────────────

export interface ParseConfigParams {
  skillName: string;
  workspacePath: string;
  variables?: Record<string, string>;
}

export interface ParseConfigResult {
  config: ProcessConfig;
  skillPath: string;
}

/**
 * Activity: resolve a skill name and parse its SKILL.md into ProcessConfig.
 */
export async function parseConfig(params: ParseConfigParams): Promise<ParseConfigResult> {
  const { skillName, workspacePath, variables } = params;

  // Prefer Horizon DB — the canonical SOP lives there and can't drift with a
  // stale S3 cache on the user's workspace.
  let skillPath = await fetchSkillFromHorizon(skillName);
  if (!skillPath) {
    skillPath = resolveSkillPathLocal(skillName, workspacePath);
  }
  if (!skillPath) {
    throw new Error(
      `SKILL.md not found for "${skillName}". ` +
      `Checked Horizon DB, workspace at ${workspacePath}, and tne-plugins. ` +
      `Set TNE_PLUGINS_PATH env var if the repo is in a non-standard location.`
    );
  }

  console.log(`[parseConfig] Resolved ${skillName} → ${skillPath}`);
  const config = parseSkillFile(skillPath, variables);
  console.log(`[parseConfig] Parsed: scope=${config.scope}, phases: ` +
    `preamble=${config.preamble.length}, generator=${config.generator.length}, ` +
    `evaluator=${config.evaluator.length}, postamble=${config.postamble.length}`);

  return { config, skillPath };
}
