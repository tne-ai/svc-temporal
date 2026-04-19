/**
 * parseConfig activity — resolves a skill name to a SKILL.md path
 * and parses it into a ProcessConfig.
 *
 * Skill resolution order:
 * 1. User's workspace: {workspacePath}/.claude/skills/{skillName}/SKILL.md
 * 2. tne-plugins repo: {tnePluginsRoot}/plugins/tne/skills/{skillName}/SKILL.md
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { parseSkillFile } from '../config/skillParser.js';
import type { ProcessConfig } from '../shared/types.js';

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

  const skillPath = resolveSkillPath(skillName, workspacePath);
  if (!skillPath) {
    throw new Error(
      `SKILL.md not found for "${skillName}". ` +
      `Checked workspace at ${workspacePath} and tne-plugins. ` +
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
