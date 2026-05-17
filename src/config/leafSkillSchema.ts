/**
 * Leaf-skill output schema loader.
 *
 * A "leaf skill" is a SKILL.md file at `tne-plugins/plugins/*\/skills/<name>/`
 * that the agent invokes via the Claude Code `Skill` tool. When a leaf skill
 * needs to produce a fixed-shape JSON output, it declares an
 * `output_schema_path` in its frontmatter pointing at a sidecar JSON Schema
 * file (typically `./output.schema.json`).
 *
 * This module reads that schema so the activity layer can forward it to the
 * Claude Agent SDK's `outputFormat` option, which uses Anthropic Structured
 * Outputs (constrained decoding) to guarantee the final response matches.
 *
 * Schema feature compatibility (per Anthropic Structured Outputs spec):
 *   - All object schemas MUST have `additionalProperties: false`
 *   - `required` must list every property that should be guaranteed present
 *   - Use `enum` for bounded values — `minimum`/`maximum` etc. are NOT
 *     enforced by the grammar even if you include them
 *
 * No changes to skillParser.ts: the existing parser handles `p-*` process
 * SKILL.md files; this loader is scoped to leaf skills which are not parsed
 * via that path.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { parse as parseYaml } from 'yaml';

/** Mirrors `findTnePluginsRoot` in activities/setupSkills.ts. */
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

function extractFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  try {
    const parsed = parseYaml(content.slice(3, end));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Walk `tne-plugins/plugins/*\/skills/` looking for a directory named exactly
 * `skillName` containing `SKILL.md`. Returns the absolute path or null.
 */
function findLeafSkillFile(skillName: string, pluginsRoot: string): string | null {
  const pluginsDir = join(pluginsRoot, 'plugins');
  let plugins: string[];
  try { plugins = readdirSync(pluginsDir); } catch { return null; }
  for (const plugin of plugins) {
    const candidate = join(pluginsDir, plugin, 'skills', skillName, 'SKILL.md');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface LoadedLeafSchema {
  /** Absolute path to the SKILL.md whose frontmatter declared this schema. */
  skillPath: string;
  /** Absolute path to the resolved schema file. */
  schemaPath: string;
  /** Parsed JSON Schema, ready to forward as Anthropic Structured Outputs. */
  schema: Record<string, unknown>;
}

/**
 * Look up a leaf skill by name and load its output JSON Schema if declared.
 *
 * Returns null when:
 *   - The leaf skill isn't found in any plugin (caller should not error;
 *     not every step has a schema-bearing leaf — many are write-a-file
 *     style and run fine without one)
 *   - The skill has no `output_schema_path` frontmatter field
 *   - The schema file is missing or unparseable (logs a warning)
 */
export function loadLeafSkillSchema(skillName: string): LoadedLeafSchema | null {
  if (!skillName) return null;
  const pluginsRoot = findTnePluginsRoot();
  if (!pluginsRoot) return null;

  const skillPath = findLeafSkillFile(skillName, pluginsRoot);
  if (!skillPath) return null;

  let content: string;
  try { content = readFileSync(skillPath, 'utf-8'); } catch { return null; }

  const fm = extractFrontmatter(content);
  const rawPath = fm?.output_schema_path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;

  const skillDir = dirname(skillPath);
  const schemaPath = isAbsolute(rawPath) ? rawPath : resolve(skillDir, rawPath);

  if (!existsSync(schemaPath)) {
    console.warn(`[loadLeafSkillSchema] skill='${skillName}' declared output_schema_path='${rawPath}' but file not found at ${schemaPath}`);
    return null;
  }

  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  } catch (err: any) {
    console.warn(`[loadLeafSkillSchema] failed to parse JSON schema at ${schemaPath}: ${err?.message}`);
    return null;
  }

  if (typeof schema !== 'object' || schema === null) {
    console.warn(`[loadLeafSkillSchema] schema at ${schemaPath} is not an object`);
    return null;
  }

  return { skillPath, schemaPath, schema: schema as Record<string, unknown> };
}
