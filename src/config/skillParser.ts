/**
 * Parse SKILL.md files into ProcessConfig.
 *
 * Ported from tne-plugins/plugins/tne/engine/parser.py.
 * Reads the /r-coo-sop1-process config block from a p-* SKILL.md and extracts
 * phases (preamble, generator, evaluator, postamble), finalization entries,
 * expert/council config, and top-level parameters.
 */

import { readFileSync } from 'fs';
import { basename, dirname } from 'path';
import {
  CouncilMember,
  EvaluatorMode,
  ExpertConfig,
  FailFastConfig,
  FinalizationEntry,
  ProcessConfig,
  StageType,
  Step,
} from '../shared/types.js';

// Built-in variable resolutions (lowest priority)
const BUILTIN_VARS: Record<string, string> = {
  'TNE-CONTEXT': 'TNE-CONTEXT',
};

const SAFE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._/-]{1,256}$/;
const NAME_VARS = new Set(['CALLER_AGENT', 'SCOPE', 'PARENT_SCOPE']);
const PATH_VAR_SUFFIXES = ['_DIR', '_PATH'];
const PATH_VARS = new Set(['OUTPUT_DIR', 'FEEDBACK_DIR', 'INPUTS_FILE']);
const NO_DEFAULT = new Set(['', '-', '—', 'none', 'None', 'N/A', 'n/a']);

// ─── Variable Sanitization ─────────────────────────────────────────────────

function sanitizeVar(key: string, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let v = value.trim().replace(/^`|`$/g, '').trim();

  if (v.length > 512) return null;
  if (/[\x00-\x1f]/.test(v.replace(/[\t\n\r]/g, ''))) return null;

  // Check shell metacharacters (allow unresolved {PLACEHOLDER} patterns)
  const strippedPlaceholders = v.replace(/\{[A-Z_][A-Z0-9_-]*\}/g, '');
  if (/[;|&$`\\<>"'!\n\r\t]/.test(strippedPlaceholders)) return null;

  if (NAME_VARS.has(key)) {
    if (!SAFE_NAME_RE.test(v)) return null;
  } else if (PATH_VARS.has(key) || PATH_VAR_SUFFIXES.some(s => key.endsWith(s))) {
    if (v.startsWith('/') || /^[A-Za-z]:\\/.test(v)) return null;
    if (v.replace(/\\/g, '/').split('/').includes('..')) return null;
    const vCheck = v.replace(/\{[A-Z_][A-Z0-9_-]*\}/g, 'X');
    if (!SAFE_PATH_RE.test(vCheck)) return null;
  }

  return v || null;
}

// ─── Variable Resolution ────────────────────────────────────────────────────

function deriveDefaultsFromPath(skillPath: string): Record<string, string> {
  const derived: Record<string, string> = {};
  const dir = basename(dirname(skillPath));
  const stem = dir === 'SKILL.md' ? basename(dirname(dirname(skillPath))) : dir;

  const m = stem.match(/^(p-([a-z]+)\d+)(?:-|$)/);
  if (m) {
    const agent = sanitizeVar('CALLER_AGENT', m[1]);
    const outdir = sanitizeVar('OUTPUT_DIR', `TNE-CONTEXT/${m[2]}`);
    if (agent) derived['CALLER_AGENT'] = agent;
    if (outdir) derived['OUTPUT_DIR'] = outdir;
  }
  return derived;
}

function extractVariableDefaults(content: string): Record<string, string> {
  const defaults: Record<string, string> = {};

  // Strategy 1: find ## Variables section
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of content.split('\n')) {
    const stripped = line.trim();
    if (/^#{1,4}\s+Variables?\s*$/i.test(stripped)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,4}\s+/.test(stripped)) break;
    if (inSection) sectionLines.push(line);
  }

  if (sectionLines.length > 0) {
    const rows = parseMarkdownTable(sectionLines.join('\n'));
    for (const row of rows) {
      const norm = normalizeRow(row);
      const keyRaw = norm['variable'] || norm['name'] || Object.values(row)[0] || '';
      const defaultRaw = norm['default'] || Object.values(row)[1] || '';
      const key = keyRaw.trim().replace(/^`|`$/g, '').trim();
      const val = defaultRaw.trim().replace(/^`|`$/g, '').trim();

      if (key && /^[A-Z_][A-Z0-9_-]*$/.test(key) && !NO_DEFAULT.has(val)) {
        const safe = sanitizeVar(key, val);
        if (safe) defaults[key] = safe;
      }
    }
    if (Object.keys(defaults).length > 0) return defaults;
  }

  // Strategy 2: regex scan for | `KEY` | `value` | patterns
  for (const line of content.split('\n')) {
    const m = line.trim().match(/^\|\s*`?([A-Z_][A-Z0-9_-]{0,63})`?\s*\|\s*`?([^|`\n]{0,256})`?\s*\|/);
    if (m) {
      const key = m[1].trim();
      const value = m[2].trim();
      if (!NO_DEFAULT.has(value) && !(key in defaults)) {
        const safe = sanitizeVar(key, value);
        if (safe) defaults[key] = safe;
      }
    }
  }

  return defaults;
}

function resolveVariables(content: string, variables: Record<string, string>): string {
  for (const [key, value] of Object.entries(variables)) {
    if (key === 'ITER') continue;
    content = content.replaceAll(`{{${key}}}`, value);
    content = content.replaceAll(`{${key}}`, value);
  }
  return content;
}

// ─── Markdown Table Parsing ─────────────────────────────────────────────────

function parseMarkdownTable(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('|'));

  if (lines.length < 2) return [];

  const headers = parseTableRow(lines[0]);
  let dataStart = 1;
  if (lines.length > 1 && /^\|[\s\-:|]+\|$/.test(lines[1])) {
    dataStart = 2;
  }

  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(dataStart)) {
    let cells = parseTableRow(line);
    // Pad or truncate to match headers
    cells = cells.slice(0, headers.length);
    while (cells.length < headers.length) cells.push('');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

function parseTableRow(line: string): string[] {
  let stripped = line.trim();
  if (stripped.startsWith('|')) stripped = stripped.slice(1);
  if (stripped.endsWith('|')) stripped = stripped.slice(0, -1);
  return stripped.split('|').map(c => c.trim());
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRow(row: Record<string, string>): Record<string, string> {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    norm[normalizeHeader(k)] = v;
  }
  return norm;
}

// ─── Config Block Extraction ────────────────────────────────────────────────

function extractRcooBlock(content: string): string | null {
  // Strategy 1: fenced code block
  const fencedRe = /```[^\n]*\n(.*?)```/gs;
  let match;
  while ((match = fencedRe.exec(content)) !== null) {
    const block = match[1];
    if (block.includes('/r-coo-sop1-process') && block.includes('SCOPE=')) {
      return block;
    }
  }

  // Strategy 2: unfenced
  const unfencedRe = /(\/r-coo-sop1-process\b.*?)(?=\n##?\s|\n---|\z)/s;
  const m2 = content.match(unfencedRe);
  if (m2) return m2[1];

  return null;
}

// ─── Block Parsing ──────────────────────────────────────────────────────────

function parseParams(lines: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith('/r-coo-sop1-process')) continue;
    if (stripped.startsWith('##')) break;
    if (stripped.includes('=') && !stripped.startsWith('|')) {
      const idx = stripped.indexOf('=');
      params[stripped.slice(0, idx).trim()] = stripped.slice(idx + 1).trim();
    }
  }
  return params;
}

function splitSections(block: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentName: string | null = null;
  const currentLines: string[] = [];

  for (const line of block.split('\n')) {
    const headerMatch = line.trim().match(/^##\s+(.+)/);
    if (headerMatch) {
      if (currentName !== null) {
        sections[currentName] = currentLines.join('\n');
        currentLines.length = 0;
      }
      const headerText = headerMatch[1].trim();
      currentName = headerText.replace(/\s*\(.*\)$/, '').toLowerCase();
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }

  if (currentName !== null) {
    sections[currentName] = currentLines.join('\n');
  }
  return sections;
}

function parseInputs(raw: string): string[] {
  if (!raw || NO_DEFAULT.has(raw)) return [];
  return raw.split(/[,+]|\band\b/).map(p => p.trim()).filter(p => p && !NO_DEFAULT.has(p));
}

function parseFailFast(row: Record<string, string>): FailFastConfig {
  let maxRetries = 3;
  let gates = [1, 2, 3, 4];

  const retriesStr = row['maxretries'] || row['failfastmaxretries'] || '';
  if (retriesStr) {
    const parsed = parseInt(retriesStr, 10);
    if (!isNaN(parsed)) maxRetries = parsed;
  }

  const gatesStr = row['gates'] || row['failfastgates'] || '';
  if (gatesStr && !NO_DEFAULT.has(gatesStr)) {
    const cleaned = gatesStr.replace(/[\[\]]/g, '');
    const parsed = cleaned.split(',').map(g => parseInt(g.trim(), 10)).filter(n => !isNaN(n));
    if (parsed.length > 0) gates = parsed;
  }

  return { maxRetries, gates };
}

function parseStepTable(sectionText: string): Step[] {
  if (!sectionText.trim()) return [];

  const rows = parseMarkdownTable(sectionText);
  if (rows.length === 0) return [];

  const steps: Step[] = [];
  for (const row of rows) {
    const norm = normalizeRow(row);

    const numberStr = norm[''] || norm['number'] || '0';
    const number = parseInt(numberStr, 10);
    if (isNaN(number) || number === 0) continue;

    const skill = norm['skill'] || '';
    if (!skill || NO_DEFAULT.has(skill)) continue;

    const inputsRaw = norm['inputs'] || norm['input'] || '';
    const inputs = parseInputs(inputsRaw);
    const output = norm['output'] || norm['outputversioned'] || norm['outputfile'] || '';
    const verify = norm['verify'] || '';
    const run = norm['run'] || '';
    const notes = norm['notes'] || '';
    const passCondition = norm['passcondition'] || norm['condition'] || '';

    let stageType = StageType.DEFAULT;
    const stageTypeStr = norm['stagetype'] || 'default';
    if (Object.values(StageType).includes(stageTypeStr as StageType)) {
      stageType = stageTypeStr as StageType;
    }

    const dependsOnRaw = norm['dependson'] || '';
    const dependsOn = (dependsOnRaw && !NO_DEFAULT.has(dependsOnRaw) && dependsOnRaw !== '[]')
      ? dependsOnRaw.split(',').map(d => d.trim()).filter(Boolean)
      : [];

    let backpropSkill = norm['backpropskill'] || '';
    if (NO_DEFAULT.has(backpropSkill) || backpropSkill === '""') backpropSkill = '';

    const failFast = parseFailFast(norm);

    let permissionMode = norm['permissionmode'] || norm['permission'] || 'acceptEdits';
    if (!permissionMode || NO_DEFAULT.has(permissionMode)) permissionMode = 'acceptEdits';

    let model = norm['model'] || '';
    if (NO_DEFAULT.has(model)) model = '';

    steps.push({
      number,
      skill,
      inputs,
      output,
      verify,
      run,
      notes,
      passCondition,
      stageType,
      dependsOn,
      backpropSkill,
      failFast,
      permissionMode,
      model,
    });
  }
  return steps;
}

function parseFinalizationTable(sectionText: string): FinalizationEntry[] {
  if (!sectionText.trim()) return [];

  const rows = parseMarkdownTable(sectionText);
  const entries: FinalizationEntry[] = [];
  for (const row of rows) {
    const norm = normalizeRow(row);
    const versioned = norm['versionedfile'] || norm['versioned'] || '';
    const final = norm['finalfile'] || norm['final'] || '';
    const strip = norm['strip'] || '';
    if (versioned && final) {
      entries.push({ versionedFile: versioned, finalFile: final, strip });
    }
  }
  return entries;
}

function parseExpertTable(sectionText: string): ExpertConfig | undefined {
  if (!sectionText.trim()) return undefined;

  const rows = parseMarkdownTable(sectionText);
  if (rows.length === 0) return undefined;

  const fields: Record<string, string> = {};
  for (const row of rows) {
    const norm = normalizeRow(row);
    const fieldName = (norm['field'] || '').toLowerCase();
    const value = norm['value'] || '';
    if (fieldName && value) fields[fieldName] = value;
  }

  return {
    source: fields['source'] || '',
    name: fields['name'] || '',
    domain: fields['domain'] || '',
    experience: fields['experience'] || '',
    philosophy: fields['philosophy'] || '',
    criteria: fields['criteria'] || '',
  };
}

function parseCouncilTable(sectionText: string): CouncilMember[] {
  if (!sectionText.trim()) return [];

  const rows = parseMarkdownTable(sectionText);
  const members: CouncilMember[] = [];
  for (const row of rows) {
    const norm = normalizeRow(row);
    const number = parseInt(norm[''] || norm['number'] || '0', 10);
    if (isNaN(number) || number === 0) continue;

    members.push({
      number,
      source: norm['source'] || '',
      name: norm['name'] || '',
      domain: norm['domain'] || '',
      focus: norm['focus'] || '',
      criteria: norm['criteria'] || '',
    });
  }
  return members;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

function parseConfigBlock(content: string): ProcessConfig {
  const block = extractRcooBlock(content);
  if (!block) {
    throw new Error(
      "No /r-coo-sop1-process config block found in SKILL.md. " +
      "Expected a fenced code block containing '/r-coo-sop1-process'."
    );
  }

  const lines = block.trim().split('\n');
  const params = parseParams(lines);

  const scope = params['SCOPE'] || '';
  const maxIterations = parseInt(params['MAX_ITERATIONS'] || '50', 10);
  const evaluatorModeStr = params['EVALUATOR_MODE'] || 'fail-fast';
  const completionThreshold = params['COMPLETION_THRESHOLD'] || '';
  const parentScope = params['PARENT_SCOPE'] || '';
  const approvalGate = (params['APPROVAL_GATE'] || 'false').toLowerCase() === 'true';
  const userCheckpoint = (params['USER_CHECKPOINT'] || 'false').toLowerCase() === 'true';
  const stageReview = (params['STAGE_REVIEW'] || 'true').toLowerCase() !== 'false';
  const preFlightInputsRaw = params['PRE_FLIGHT_INPUTS'] || '';
  const preFlightInputs = preFlightInputsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const inputsFile = params['INPUTS_FILE'] || '';
  const inputsBackprop = (params['INPUTS_BACKPROP'] || 'true').toLowerCase() !== 'false';
  const inputsBackpropGate = params['INPUTS_BACKPROP_GATE'] || 'after_evaluator';

  let evaluatorMode: EvaluatorMode;
  try {
    evaluatorMode = Object.values(EvaluatorMode).includes(evaluatorModeStr as EvaluatorMode)
      ? evaluatorModeStr as EvaluatorMode
      : EvaluatorMode.FAIL_FAST;
  } catch {
    evaluatorMode = EvaluatorMode.FAIL_FAST;
  }

  const sections = splitSections(block);

  return {
    scope,
    maxIterations,
    evaluatorMode,
    completionThreshold,
    parentScope,
    approvalGate,
    userCheckpoint,
    stageReview,
    preFlightInputs,
    inputsFile,
    inputsBackprop,
    inputsBackpropGate,
    preamble: parseStepTable(sections['preamble'] || ''),
    generator: parseStepTable(sections['generator'] || ''),
    evaluator: parseStepTable(sections['evaluator'] || ''),
    postamble: parseStepTable(sections['postamble'] || ''),
    finalization: parseFinalizationTable(sections['finalization'] || ''),
    expert: parseExpertTable(sections['expert'] || ''),
    council: parseCouncilTable(sections['council'] || ''),
  };
}

/**
 * Parse a SKILL.md file into a ProcessConfig.
 *
 * Variable resolution uses a 4-layer fallback ladder (highest priority wins):
 * 1. Explicit variables from the caller
 * 2. Variables table defaults declared in ## Variables section
 * 3. Defaults derived from the skill filename
 * 4. Built-in system variables
 */
export function parseSkillFile(
  path: string,
  variables?: Record<string, string>,
): ProcessConfig {
  const content = readFileSync(path, 'utf-8');

  const skillDefaults = extractVariableDefaults(content);
  const filenameDefaults = deriveDefaultsFromPath(path);

  const merged: Record<string, string> = {
    ...BUILTIN_VARS,
    ...filenameDefaults,
    ...skillDefaults,
    ...(variables || {}),
  };

  const resolved = Object.keys(merged).length > 0
    ? resolveVariables(content, merged)
    : content;

  return parseConfigBlock(resolved);
}

// Re-export for testing
export {
  parseMarkdownTable,
  parseConfigBlock,
  extractVariableDefaults,
  resolveVariables,
  sanitizeVar,
  normalizeHeader,
};
