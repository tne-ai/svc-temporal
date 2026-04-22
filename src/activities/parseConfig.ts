/**
 * parseConfig activity — resolves a skill name to a SKILL.md path
 * and parses it into a ProcessConfig.
 *
 * Skill resolution order:
 * 1. User's workspace: {workspacePath}/.claude/skills/{skillName}/SKILL.md
 * 2. tne-plugins repo: {tnePluginsRoot}/plugins/tne/skills/{skillName}/SKILL.md
 * 3. Horizon DB via HTTP: fetched from /api/fsm-invoke/skill/:name and
 *    cached to a temp dir. Handles the case where orion's DB has been synced
 *    from a newer tne-plugins than what is baked into this worker's image.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
    if (existsSync(join(p, 'plugins', 'tne', 'skills'))) return p;
  }
  return null;
}

/**
 * Resolve a skill name to its SKILL.md file path.
 * Checks the user's workspace first, then the tne-plugins repository.
 */
function resolveSkillPath(skillName: string, workspacePath: string): string | null {
  // 1. User's workspace — check workspacePath and up to 2 parent dirs
  let check = workspacePath;
  for (let i = 0; i < 3; i++) {
    const wsSkill = join(check, '.claude', 'skills', skillName, 'SKILL.md');
    if (existsSync(wsSkill)) return wsSkill;
    const parent = resolve(check, '..');
    if (parent === check) break;
    check = parent;
  }

  // 2. tne-plugins repository
  const root = getTnePluginsRoot();
  if (root) {
    const pluginSkill = join(root, 'plugins', 'tne', 'skills', skillName, 'SKILL.md');
    if (existsSync(pluginSkill)) return pluginSkill;
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

  let skillPath = resolveSkillPath(skillName, workspacePath);
  if (!skillPath) {
    skillPath = await fetchSkillFromHorizon(skillName);
  }
  if (!skillPath) {
    throw new Error(
      `SKILL.md not found for "${skillName}". ` +
      `Checked workspace at ${workspacePath}, tne-plugins, and Horizon DB. ` +
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
