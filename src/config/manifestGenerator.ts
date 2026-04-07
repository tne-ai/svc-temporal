/**
 * Generate a manifest of non-stale output files for skill consumption.
 *
 * Ported from tne-plugins/plugins/tne/engine/manifest.py.
 * Produces a markdown manifest listing all COMPLETE output files from prior steps.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { dirname, basename, join } from 'path';
import { ProcessConfig, StepStatus } from '../shared/types.js';
import type { FsmWorkflowState } from '../shared/types.js';

const HEADING_RE = /^#{1,3}\s+(.+)/m;

interface ManifestEntry {
  filepath: string;
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

function fileEntry(filepath: string, status = 'COMPLETE', sourceSkill = ''): ManifestEntry {
  let mtimeRaw = 0;
  try {
    mtimeRaw = statSync(filepath).mtimeMs / 1000;
  } catch { /* ignore */ }

  const mtime = new Date(mtimeRaw * 1000).toISOString().slice(0, 16).replace('T', ' ');

  return {
    filepath,
    filename: basename(filepath),
    source: sourceSkill || basename(filepath, '.md'),
    status,
    mtime,
    mtimeRaw,
    summary: extractFirstHeading(filepath),
  };
}

/**
 * Generate a manifest of non-stale files available to the current step.
 *
 * @returns Path to the generated manifest file
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
  const entries: ManifestEntry[] = [];

  // 1. Always include master inputs file
  if (inputsFile && existsSync(inputsFile)) {
    entries.push(fileEntry(inputsFile, 'MASTER_INPUT'));
  }
  const envInputs = process.env['FSM_INPUTS_FILE'] || '';
  if (envInputs && existsSync(envInputs) && envInputs !== inputsFile) {
    entries.push(fileEntry(envInputs, 'PARENT_INPUT'));
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

    const outputPath = step.output;
    if (!outputPath) continue;

    if (outputPath.includes('*')) {
      // Glob patterns — list matching files
      const dir = dirname(outputPath);
      if (existsSync(dir)) {
        const pattern = basename(outputPath).replace(/\*/g, '.*');
        const re = new RegExp(`^${pattern}$`);
        for (const file of readdirSync(dir).sort()) {
          if (re.test(file) && file !== '_manifest.md') {
            const fullPath = join(dir, file);
            entries.push(fileEntry(fullPath, status, step.skill));
          }
        }
      }
    } else if (existsSync(outputPath)) {
      entries.push(fileEntry(outputPath, status, step.skill));
    }
  }

  // 3. Include feedback files
  if (feedbackDir && existsSync(feedbackDir)) {
    try {
      for (const file of readdirSync(feedbackDir).sort()) {
        if (file.endsWith('.md') && file !== '_manifest.md') {
          entries.push(fileEntry(join(feedbackDir, file), 'FEEDBACK'));
        }
      }
    } catch { /* ignore */ }
  }

  // 4. Write manifest
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const tableRows = entries.map((e, i) =>
    `| ${i + 1} | \`${e.filename}\` | ${e.source} | ${e.status} | ${e.mtime} | ${e.summary} |`
  );
  const table = [
    '| # | File | Source | Status | Modified | Summary |',
    '|---|------|--------|--------|----------|---------|',
    ...tableRows,
  ].join('\n');

  const manifestContent = [
    `# Input Manifest for ${currentStepKey}`,
    '',
    `Generated: ${now}`,
    `Files available: ${entries.length}`,
    '',
    table,
    '',
    '**Instructions:** Read files relevant to your task. ' +
    'You do NOT need to read all files — select based on your skill\'s purpose.',
    '',
  ].join('\n');

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifestContent);

  return manifestPath;
}
