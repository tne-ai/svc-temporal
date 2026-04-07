/**
 * Template variable resolution for engine config and prompts.
 *
 * Ported from tne-plugins/plugins/tne/engine/template.py.
 * Loads key-value pairs from a markdown inputs file and resolves
 * {{VARIABLE}} placeholders in output paths, notes, and prompts.
 */

import { readFileSync } from 'fs';

/**
 * Parse a markdown inputs file and return a variable substitution dict.
 *
 * Reads lines of the form `**Key:** Value` (or bare `Key: Value`) and produces:
 * - `KEY_NAME` → value (as-is, for description/path fields)
 * - For "* Name" fields: short kebab-case token (e.g. FEATURE → "openclaw-for-compass")
 */
export function loadInputsVars(inputsFile: string): Record<string, string> {
  const vars: Record<string, string> = {};

  let content: string;
  try {
    content = readFileSync(inputsFile, 'utf-8');
  } catch {
    return vars;
  }

  // Match lines like:
  //   **Feature Name:** OpenClaw for Compass
  //   Feature Name: OpenClaw for Compass
  const pattern = /^\**\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*:\**\s*(.+)$/gm;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    const rawKey = match[1].trim();
    const value = match[2].trim();

    // Normalized underscore-uppercase key: "Feature Name" → FEATURE_NAME
    const normalized = rawKey.replace(/\s+/g, '_').toUpperCase();
    vars[normalized] = value;

    // Single-word key: also add bare form
    if (!rawKey.includes(' ')) {
      vars[rawKey.toUpperCase()] = value;
    }

    // Short kebab token for "* Name" fields:
    // "Feature Name" → FEATURE = "openclaw-for-compass"
    const nameMatch = rawKey.match(/^(\w+)\s+Name$/i);
    if (nameMatch) {
      const shortKey = nameMatch[1].toUpperCase();
      vars[shortKey] = toKebab(value);
    }
  }

  return vars;
}

/**
 * Replace `{{KEY}}` placeholders in text using vars.
 * `{{ITER}}` is intentionally left untouched for runtime substitution.
 */
export function resolveTemplateVars(text: string, vars: Record<string, string>): string {
  if (!vars || !text) return text;

  for (const [key, value] of Object.entries(vars)) {
    if (key === 'ITER') continue;
    text = text.replaceAll(`{{${key}}}`, value);
  }

  return text;
}

/**
 * Convert a human-readable string to lowercase kebab-case.
 */
function toKebab(value: string): string {
  let s = value.toLowerCase().trim();
  s = s.replace(/[^a-z0-9]+/g, '-');
  return s.replace(/^-|-$/g, '');
}
