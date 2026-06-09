/**
 * llm-cli.yaml role → model resolution.
 *
 * Parity with the Python engine, which reads
 * `plugins/tne/config/llm-cli.yaml` to pick a model per role. The `roles`
 * map is a flat `{ <role>: { cmd, args, model } }` structure; this module
 * resolves `roles.<role>.model`.
 *
 * Used by the gate cascade: the `similarity` role (scalar scoring) is the
 * engine equivalent of the gate model. Activities-only — reads from disk —
 * never import from workflow code.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

interface RoleEntry {
  cmd?: string;
  args?: string[];
  model?: string | null;
}

interface LlmCliConfig {
  roles?: Record<string, RoleEntry>;
}

/** Candidate paths for the bundled llm-cli.yaml, tried in order. */
const CANDIDATE_PATHS = [
  // Relative to the repo root (src/config → ../../tne-plugins/...).
  join(process.cwd(), 'tne-plugins', 'plugins', 'tne', 'config', 'llm-cli.yaml'),
  // Container layout.
  '/app/tne-plugins/plugins/tne/config/llm-cli.yaml',
];

/** Sentinel: undefined = not yet loaded; null = load attempted, no file. */
let cached: LlmCliConfig | null | undefined;

/** Load + parse the llm-cli.yaml once, caching the result (including a
 *  null "couldn't find / parse it" outcome so we don't re-stat every call). */
function loadConfig(): LlmCliConfig | null {
  if (cached !== undefined) return cached;
  for (const path of CANDIDATE_PATHS) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseYaml(readFileSync(path, 'utf8')) as LlmCliConfig;
      cached = parsed && typeof parsed === 'object' ? parsed : null;
      return cached;
    } catch {
      // Malformed yaml — treat as absent.
    }
  }
  cached = null;
  return cached;
}

/**
 * Resolve the model configured for `role` in llm-cli.yaml.
 * Returns the model string, or null when the role / model / file is absent.
 */
export function roleModel(role: string): string | null {
  const cfg = loadConfig();
  const model = cfg?.roles?.[role]?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

/** Test hook — resets the module-level cache. */
export function resetLlmCliConfigCache(): void {
  cached = undefined;
}
