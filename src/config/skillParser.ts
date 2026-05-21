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
import { parse as parseYaml } from 'yaml';
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

/**
 * Fast path: extract the SOP config from YAML frontmatter `sop:` key.
 * Returns the raw string value (same text format as legacy fenced blocks)
 * or null if no frontmatter or no `sop:` key.
 *
 * Mirrors Python's _parse_frontmatter_sop in tne-plugins/engine/parser.py.
 */
function extractFrontmatterSop(content: string): string | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const fmText = content.slice(3, end);
  let fm: any;
  try {
    fm = parseYaml(fmText);
  } catch {
    return null;
  }
  const sop = fm?.sop;
  return typeof sop === 'string' ? sop : null;
}

/**
 * Structured frontmatter SOP — `process_type: r-coo-sop91-process` + a
 * YAML-mapping `sop:` declaring `phases.{preamble,generator,evaluator,
 * postamble}.steps`. The body of these skills only carries a marker comment
 * (`<!-- config in sop: frontmatter -->`) so every other extractor returns
 * null. Mirrors the Python parser's `_parse_sop_dict` in tne-plugins/engine.
 *
 * Returns a fully-populated ProcessConfig (with defaults for fields the dict
 * form does not declare) or null when no usable `sop:` mapping is present.
 */
function parseFrontmatterDictSop(
  content: string,
  fallbackScope: string,
): ProcessConfig | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const fmText = content.slice(3, end);
  let fm: any;
  try {
    fm = parseYaml(fmText);
  } catch {
    return null;
  }
  const sop = fm?.sop;
  if (!sop || typeof sop !== 'object' || Array.isArray(sop)) return null;

  // Scope: sop.scope > frontmatter name > caller-derived fallback.
  let scope = typeof sop.scope === 'string' ? sop.scope.trim() : '';
  if (!scope && typeof fm.name === 'string') scope = fm.name.trim();
  if (!scope) scope = fallbackScope;

  const maxIterations =
    typeof sop.max_iterations === 'number'
      ? sop.max_iterations
      : parseInt(String(sop.max_iterations ?? '50'), 10) || 50;

  const evalStr = String(sop.evaluator_mode ?? 'fail-fast');
  const evaluatorMode: EvaluatorMode = Object.values(EvaluatorMode).includes(
    evalStr as EvaluatorMode,
  )
    ? (evalStr as EvaluatorMode)
    : EvaluatorMode.FAIL_FAST;

  const phases = sop.phases ?? {};
  const preambleDict = phases.preamble ?? {};
  const generatorDict = phases.generator ?? {};
  const evaluatorDict = phases.evaluator ?? {};
  const postambleDict = phases.postamble ?? {};

  const stepsFromPhase = (phaseDict: any): Step[] => {
    if (!phaseDict || typeof phaseDict !== 'object') return [];
    const rawSteps = phaseDict.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) return [];

    // Map declared step ids to the sequential integers the wave scheduler
    // expects, so `depends_on: [my-id]` resolves to `dependsOn: ['2']`.
    const idToNum: Record<string, string> = {};
    rawSteps.forEach((s: any, i: number) => {
      const sid = typeof s?.id === 'string' && s.id ? s.id : String(i + 1);
      idToNum[sid] = String(i + 1);
    });

    return rawSteps.map((s: any, i: number) => {
      const rawDeps: unknown = s?.depends_on ?? [];
      const depsList = Array.isArray(rawDeps) ? rawDeps : [];
      const dependsOn = depsList
        .filter((d): d is string => typeof d === 'string' && d in idToNum)
        .map(d => idToNum[d]);

      const rawInputs: unknown = s?.inputs ?? [];
      const inputs: string[] = Array.isArray(rawInputs)
        ? rawInputs.map(v => String(v))
        : typeof rawInputs === 'string'
          ? [rawInputs]
          : [];

      return {
        number: String(i + 1),
        skill: typeof s?.skill === 'string' && s.skill ? s.skill : 'inline',
        inputs,
        output: typeof s?.output === 'string' ? s.output : '',
        verify: '',
        run: '',
        notes:
          typeof s?.description === 'string'
            ? s.description
            : typeof s?.id === 'string'
              ? s.id
              : '',
        passCondition:
          typeof s?.pass_condition === 'string' ? s.pass_condition : '',
        stageType: StageType.DEFAULT,
        dependsOn,
        backpropSkill: '',
        failFast: { maxRetries: 3, gates: [1, 2, 3, 4] },
        permissionMode: 'acceptEdits',
        model: '',
      };
    });
  };

  const preamble = stepsFromPhase(preambleDict);
  const generator = stepsFromPhase(generatorDict);
  const evaluator = stepsFromPhase(evaluatorDict);
  const postamble = stepsFromPhase(postambleDict);

  if (
    preamble.length + generator.length + evaluator.length + postamble.length ===
    0
  ) {
    // Empty mapping — let the rest of the ladder try its luck instead.
    return null;
  }

  return {
    scope,
    maxIterations,
    evaluatorMode,
    completionThreshold: '',
    parentScope: '',
    approvalGate: Boolean(preambleDict?.human_gate),
    userCheckpoint: false,
    stageReview: true,
    preFlightInputs: [],
    inputsFile: '',
    inputsBackprop: true,
    inputsBackpropGate: 'after_evaluator',
    parallelGenerator: false,
    preamble,
    generator,
    evaluator,
    postamble,
    finalization: [],
    council: [],
  };
}

function hasStepTables(block: string): boolean {
  return /^\s*\|---/m.test(block);
}

function extractRcooBlock(content: string): string | null {
  // Strategy 1: fenced code blocks containing /r-coo-sop1-process. Walk lines
  // so we can track the enclosing heading level for each block.
  //
  // Only accept blocks at top-level (no heading before them) or under a `##`
  // heading. Blocks nested under `###`+ subsections are rejected — those are
  // documentary snippets (e.g. `### Phase 1: Strategy` → `#### r-coo-sop1…`
  // in p-ceo1-manage-strategy), not the orchestrator's own SOP.
  const lines = content.split('\n');
  const candidates: string[] = [];
  let currentHeadingLevel = 0;
  let inFence = false;
  let blockStart = -1;
  let blockHeadingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (!inFence) {
      const h = trimmed.match(/^(#{1,6})\s+\S/);
      if (h) {
        currentHeadingLevel = h[1].length;
        continue;
      }
      if (trimmed.startsWith('```')) {
        inFence = true;
        blockStart = i + 1;
        blockHeadingLevel = currentHeadingLevel;
      }
    } else if (trimmed.startsWith('```')) {
      const body = lines.slice(blockStart, i).join('\n');
      inFence = false;
      blockStart = -1;
      // Level 0 = top of file; level ≤ 2 = `#` or `##` — these are acceptable
      // top-level SOP containers. Level ≥ 3 means the block lives inside a
      // subsection and must be ignored.
      if (
        blockHeadingLevel <= 2 &&
        body.includes('/r-coo-sop1-process') &&
        body.includes('SCOPE=')
      ) {
        candidates.push(body);
      }
    }
  }

  if (candidates.length > 0) {
    for (const block of candidates) {
      if (hasStepTables(block)) return block;
    }
    return candidates[0];
  }

  // Strategy 2: unfenced
  const unfencedRe = /(\/r-coo-sop1-process\b.*?)(?=\n##?\s|\n---|\z)/s;
  const m2 = content.match(unfencedRe);
  if (m2) return m2[1];

  return null;
}

/**
 * Primary format (PR #1061): `## SOP` heading followed by a fenced block.
 * Returns the fenced block body, or null if `## SOP` is absent or empty.
 */
function extractBodySopBlock(content: string): string | null {
  let body = content;
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) body = content.slice(end + 4);
  }
  const sopMatch = body.match(/^## SOP\s*$/m);
  if (!sopMatch || sopMatch.index === undefined) return null;
  const after = body.slice(sopMatch.index + sopMatch[0].length);
  const fence = after.match(/^```[^\n]*\n(.*?)^```/ms);
  return fence ? fence[1] : null;
}

/**
 * Legacy-inline format: `/r-coo-sop1-process` appears with sibling
 * `## Preamble / ## Generator / …` headings. The `/r-coo-sop1-process` line
 * itself may or may not be fenced; the phase sections are outside any fence.
 * Assembles a synthetic block by collecting lines from the first
 * `/r-coo-sop1-process` through the next non-phase `##` heading or `---`
 * separator, stripping fence markers so `splitSections` parses cleanly.
 */
function extractInlineLegacyBlock(content: string): string | null {
  const lines = content.split('\n');
  const PHASE = /^##\s+(preamble|generator|evaluator|postamble|finalization|expert|council)\b/i;

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\/r-coo-sop1-process\b/.test(lines[i].trim())) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;

  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) continue;  // strip fence markers
    const trimmed = line.trim();
    // Note: bare `---` is a markdown horizontal rule inside the body — not a
    // terminator. Only `##` non-phase headings end the config section.
    if (/^##\s+/.test(trimmed) && !PHASE.test(trimmed) && i !== startIdx) break;
    collected.push(line);
  }
  const block = collected.join('\n').trim();
  return block || null;
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

    // Accept several column names for the step identifier. `#` (the canonical
    // SOP form) normalizes to `''`; `Phase` is used by p-ceo* skills where
    // labels like `0a`/`1b` matter; `Number` appears in some legacy skills.
    const rawNumber = (norm[''] || norm['number'] || norm['phase'] || '').trim();
    if (!rawNumber || NO_DEFAULT.has(rawNumber)) continue;
    // Sanity guard: a plain integer `0` is the parseMarkdownTable sentinel for
    // an empty cell in older column layouts. Keep rejecting it so an alignment
    // bug doesn't produce a phantom step.
    if (rawNumber === '0') continue;

    // `Skill` is canonical; `Name` is the p-ceo* equivalent.
    const skill = norm['skill'] || norm['name'] || '';
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

    const dependsOnRaw = norm['dependson'] || norm['dependencies'] || '';
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
      number: rawNumber,
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

function parseBlockText(block: string): ProcessConfig {
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
  const parallelGenerator = (params['PARALLEL_GENERATOR'] || 'false').toLowerCase() === 'true';

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
    parallelGenerator,
    preamble: parseStepTable(sections['preamble'] || ''),
    generator: parseStepTable(sections['generator'] || ''),
    evaluator: parseStepTable(sections['evaluator'] || ''),
    postamble: parseStepTable(sections['postamble'] || ''),
    finalization: parseFinalizationTable(sections['finalization'] || ''),
    expert: parseExpertTable(sections['expert'] || ''),
    council: parseCouncilTable(sections['council'] || ''),
  };
}

function parseConfigBlock(content: string): ProcessConfig {
  const block = extractRcooBlock(content);
  if (!block) {
    throw new Error(
      "No /r-coo-sop1-process config block found in SKILL.md. " +
      "Expected a fenced code block containing '/r-coo-sop1-process'."
    );
  }
  return parseBlockText(block);
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

  // Strategy ladder. tne-plugins has four SOP formats in the wild:
  //   1. ## SOP body block          — current primary (PR #1061)
  //   2. frontmatter `sop:` string  — PR #991 middle format, still in flight
  //   3. inline legacy              — unfenced /r-coo-sop1-process with sibling
  //                                   ## Preamble / ## Generator / … headings
  //   4. frontmatter `sop:` dict    — `process_type: r-coo-sop91-process`,
  //                                   `sop: phases: …`. Body carries only a
  //                                   `<!-- config in sop: frontmatter -->`
  //                                   marker, so the string extractors return
  //                                   null. The dict extractor produces a
  //                                   ProcessConfig directly.
  //
  // Run every extractor and pick the config with the most phases. Tie goes to
  // the earlier extractor (so ## SOP beats `sop:` at equal phase counts).
  //
  // "First non-zero wins" was the old rule and broke on half-migrated skills:
  // observed on 2026-04-24 with a `## SOP` stub (SCOPE-only) alongside an
  // older `sop:` frontmatter that still carried a one-row preamble. The stub
  // parsed to 0 phases and was skipped, but the stale frontmatter parsed to
  // 1 phase and won — running the workflow against the old illustrative SOP.
  // Preferring the max-phase candidate would have picked the real `## SOP`
  // block if it were populated, and still falls back to the frontmatter only
  // when the body block is genuinely empty.
  const stringExtractors: Array<[label: string, fn: () => string | null]> = [
    ['body-sop', () => extractBodySopBlock(resolved)],
    ['frontmatter-sop', () => extractFrontmatterSop(resolved)],
    ['fenced-rcoo', () => extractRcooBlock(resolved)],
    ['inline-legacy', () => extractInlineLegacyBlock(resolved)],
  ];

  const candidates: Array<{ cfg: ProcessConfig; phases: number; label: string }> = [];
  for (const [label, extract] of stringExtractors) {
    const block = extract();
    if (!block) continue;
    const cfg = parseBlockText(block);
    candidates.push({
      cfg,
      phases:
        cfg.preamble.length +
        cfg.generator.length +
        cfg.evaluator.length +
        cfg.postamble.length,
      label,
    });
  }

  const dictCfg = parseFrontmatterDictSop(
    resolved,
    filenameDefaults['CALLER_AGENT'] || '',
  );
  if (dictCfg) {
    candidates.push({
      cfg: dictCfg,
      phases:
        dictCfg.preamble.length +
        dictCfg.generator.length +
        dictCfg.evaluator.length +
        dictCfg.postamble.length,
      label: 'frontmatter-dict',
    });
  }

  let best: { cfg: ProcessConfig; phases: number; label: string } | null = null;
  for (const c of candidates) {
    // Strict `>` preserves tiebreaker-by-order (string extractors first, then
    // the dict candidate as the final fallback).
    if (!best || c.phases > best.phases) best = c;
  }

  if (best) return best.cfg;
  throw new Error(
    "No /r-coo-sop1-process config block found in SKILL.md. " +
    "Expected a fenced code block containing '/r-coo-sop1-process'."
  );
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
