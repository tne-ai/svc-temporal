/**
 * Generate a manifest of non-stale output files for skill consumption.
 *
 * Ported from tne-plugins/plugins/tne/engine/manifest.py.
 * Produces a markdown manifest listing all COMPLETE output files from prior steps.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { dirname, basename, isAbsolute, join } from 'path';
import { ProcessConfig, StepStatus } from '../shared/types.js';
import type { FsmWorkflowState } from '../shared/types.js';

/** Resolve a (possibly-relative) path against a base directory for filesystem
 *  checks, without mutating process.cwd. Absolute paths pass through. */
function resolvePath(p: string, base?: string): string {
  if (!p) return p;
  if (isAbsolute(p)) return p;
  if (!base) return p;
  return join(base, p);
}

const HEADING_RE = /^#{1,3}\s+(.+)/m;

interface ManifestEntry {
  filepath: string;
  /** Path to show to the agent — usually workingDir-relative. Falls back
   *  to `filepath` if no relative form is available. */
  displayPath: string;
  filename: string;
  source: string;
  status: string;
  mtime: string;
  mtimeRaw: number;
  summary: string;
}

function extractFirstHeading(filepath: string): string {
  try {
    let content = readFileSync(filepath, { encoding: 'utf-8' }).slice(0, 2048);

    // Skip YAML frontmatter
    if (content.startsWith('---')) {
      const end = content.indexOf('---', 3);
      if (end > 0) content = content.slice(end + 3);
    }

    const match = HEADING_RE.exec(content);
    if (match) {
      const heading = match[1].trim();
      return heading.length > 80 ? heading.slice(0, 80) + '...' : heading;
    }
    return '(no heading)';
  } catch {
    return '(unreadable)';
  }
}

function fileEntry(
  filepath: string,
  status = 'COMPLETE',
  sourceSkill = '',
  displayPath?: string,
): ManifestEntry {
  let mtimeRaw = 0;
  try {
    mtimeRaw = statSync(filepath).mtimeMs / 1000;
  } catch { /* ignore */ }

  const mtime = new Date(mtimeRaw * 1000).toISOString().slice(0, 16).replace('T', ' ');

  return {
    filepath,
    displayPath: displayPath || filepath,
    filename: basename(filepath),
    source: sourceSkill || basename(filepath, '.md'),
    status,
    mtime,
    mtimeRaw,
    summary: extractFirstHeading(filepath),
  };
}

/**
 * Build a manifest markdown string without touching disk. Used by the
 * executeStep activity to embed prior-step context directly in the agent
 * prompt. Returns the empty string when there are no entries to list —
 * callers can use `if (content)` to skip emitting a "## Available Inputs"
 * section when nothing useful is available yet.
 */
export function buildManifestContent(
  state: FsmWorkflowState,
  config: ProcessConfig,
  currentStepKey: string,
  inputsFile = '',
  feedbackDir = '',
  resolveBase?: string,
): string {
  const entries: ManifestEntry[] = [];

  // 1. Always include master inputs file
  const resolvedInputs = resolvePath(inputsFile, resolveBase);
  if (inputsFile && existsSync(resolvedInputs)) {
    entries.push(fileEntry(resolvedInputs, 'MASTER_INPUT', '', inputsFile));
  }
  const envInputs = process.env['FSM_INPUTS_FILE'] || '';
  const resolvedEnvInputs = resolvePath(envInputs, resolveBase);
  if (envInputs && existsSync(resolvedEnvInputs) && envInputs !== inputsFile) {
    entries.push(fileEntry(resolvedEnvInputs, 'PARENT_INPUT', '', envInputs));
  }

  // 2. Collect all COMPLETE step outputs
  const allSteps: Array<{ phase: string; step: ProcessConfig['preamble'][0] }> = [
    ...config.preamble.map(s => ({ phase: 'preamble', step: s })),
    ...config.generator.map(s => ({ phase: 'generator', step: s })),
    ...config.evaluator.map(s => ({ phase: 'evaluator', step: s })),
    ...config.postamble.map(s => ({ phase: 'postamble', step: s })),
  ];

  for (const { phase, step } of allSteps) {
    const stepKey = `${phase}.${step.number}`;
    if (stepKey === currentStepKey) break;

    const stepState = state.steps[stepKey];
    const status = stepState?.status || StepStatus.PENDING;
    if (status !== StepStatus.COMPLETE) continue;

    // Prefer the actual written outputPath recorded in state over the SOP
    // template (state's path already has templateVars resolved and may reflect
    // the agent-chosen path when the template was `{OUTPUT_DIR}/...`).
    const recordedPath = stepState?.outputPath || step.output;
    if (!recordedPath) continue;
    const outputPath = resolvePath(recordedPath, resolveBase);

    if (recordedPath.includes('*')) {
      // Glob patterns — list matching files
      const dir = dirname(outputPath);
      if (existsSync(dir)) {
        const pattern = basename(outputPath).replace(/\*/g, '.*');
        const re = new RegExp(`^${pattern}$`);
        for (const file of readdirSync(dir).sort()) {
          if (re.test(file) && file !== '_manifest.md') {
            const fullPath = join(dir, file);
            const displayPath = resolveBase && fullPath.startsWith(resolveBase)
              ? fullPath.slice(resolveBase.length).replace(/^\/+/, '')
              : fullPath;
            entries.push(fileEntry(fullPath, status, step.skill, displayPath));
          }
        }
      }
    } else if (existsSync(outputPath)) {
      entries.push(fileEntry(outputPath, status, step.skill, recordedPath));
    }
  }

  // 3. Include feedback files
  const resolvedFeedbackDir = resolvePath(feedbackDir, resolveBase);
  if (feedbackDir && existsSync(resolvedFeedbackDir)) {
    try {
      for (const file of readdirSync(resolvedFeedbackDir).sort()) {
        if (file.endsWith('.md') && file !== '_manifest.md') {
          const fullPath = join(resolvedFeedbackDir, file);
          const displayPath = join(feedbackDir, file);
          entries.push(fileEntry(fullPath, 'FEEDBACK', '', displayPath));
        }
      }
    } catch { /* ignore */ }
  }

  if (entries.length === 0) return '';

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const tableRows = entries.map((e, i) =>
    `| ${i + 1} | \`${e.displayPath}\` | ${e.source} | ${e.status} | ${e.mtime} | ${e.summary} |`
  );
  const table = [
    '| # | File | Source | Status | Modified | Summary |',
    '|---|------|--------|--------|----------|---------|',
    ...tableRows,
  ].join('\n');

  return [
    `Generated: ${now}`,
    `Files available: ${entries.length}`,
    '',
    table,
    '',
    '**Instructions:** Read files relevant to your task. ' +
    'You do NOT need to read all files — select based on your skill\'s purpose.',
  ].join('\n');
}

/**
 * Generate a manifest of non-stale files available to the current step and
 * write it to `{outputDir}/_manifest.md`. Returns the file path.
 *
 * Kept for callers that want the manifest as a file on disk (e.g. some
 * downstream skills expect it at `{MANIFEST}` in the working directory).
 * Most new code should use `buildManifestContent` and embed inline in the
 * prompt instead.
 */
export function generateManifest(
  state: FsmWorkflowState,
  config: ProcessConfig,
  outputDir: string,
  currentStepKey: string,
  inputsFile = '',
  feedbackDir = '',
): string {
  const manifestPath = join(outputDir, '_manifest.md');
  const body = buildManifestContent(state, config, currentStepKey, inputsFile, feedbackDir);
  const content = [`# Input Manifest for ${currentStepKey}`, '', body, ''].join('\n');

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, content);

  return manifestPath;
}
