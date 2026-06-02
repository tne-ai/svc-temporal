/**
 * backpropInputs — file-I/O half of the backprop-to-inputs feature.
 *
 * Faithful port of the I/O parts of the Python engine's `backprop_inputs.py`:
 *   • scanOutputForFindings  — read a step's output file and pull out its
 *                              `## Backprop to Inputs` section as a finding.
 *   • applyFindingsToInputs  — append approved findings under a
 *                              `## Pipeline Feedback` section of the master
 *                              inputs file.
 *
 * The pure helpers (regexes, scanFeedbackForFindings, formatFindingsForReview)
 * live in `src/shared/backpropFindings.ts` so workflow code can import them
 * without pulling in `fs`. This file is activities-only.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { InputFinding } from '../shared/types.js';
import { extractSectionFromOutput } from '../shared/backpropFindings.js';

/**
 * Read `outputPath` and, if it contains a non-empty `## Backprop to Inputs`
 * section, return a single pending finding. Returns [] on any read error or
 * when no section is present.
 *
 * Mirrors Python `scan_output_for_findings`. Synchronous fs is fine here —
 * this runs inside executeStep, never in workflow code.
 */
export function scanOutputForFindings(
  outputPath: string,
  stepKey: string,
  skillName: string,
  timestamp: string,
): InputFinding[] {
  let text: string;
  try {
    text = readFileSync(outputPath, 'utf8');
  } catch {
    // Mirror Python returning [] on OSError.
    return [];
  }
  const section = extractSectionFromOutput(text);
  if (!section) return [];
  return [
    {
      sourceStep: stepKey,
      sourceSkill: skillName,
      content: section,
      timestamp,
      status: 'pending',
    },
  ];
}

export interface ApplyFindingsParams {
  /** Workspace root (same semantics as FsmProcessInput.workspacePath). */
  workspacePath: string;
  /** Inputs file path, relative to the workspace (ProcessConfig.inputsFile)
   *  or absolute. */
  inputsRelPath: string;
  /** Findings to apply — only those with status `approved` are written. */
  findings: InputFinding[];
}

/**
 * Append approved findings to the master inputs file under a
 * `## Pipeline Feedback` section.
 *
 * Layout per approved finding:
 *   ### Pipeline Feedback -- {timestamp}
 *
 *   **From {skill} (step {step}):**
 *
 *   {content}
 *
 * If a `## Pipeline Feedback` heading already exists, the new block is
 * inserted just before the next `## ` heading after it (or appended at the
 * end of the file if it's the last section). Otherwise a fresh
 * `## Pipeline Feedback` section is appended to the end of the file.
 *
 * Returns true when something was written, false when there were no approved
 * findings or the file couldn't be read/written.
 *
 * Mirrors Python `apply_findings_to_inputs`.
 */
export async function applyFindingsToInputs(params: ApplyFindingsParams): Promise<boolean> {
  const { workspacePath, inputsRelPath, findings } = params;
  if (!inputsRelPath) return false;

  const approved = findings.filter((f) => f.status === 'approved');
  if (approved.length === 0) return false;

  const inputsPath = isAbsolute(inputsRelPath)
    ? inputsRelPath
    : join(workspacePath, inputsRelPath);

  let original: string;
  try {
    original = existsSync(inputsPath) ? readFileSync(inputsPath, 'utf8') : '';
  } catch {
    return false;
  }

  // Build the markdown block for the approved findings.
  const blocks: string[] = [];
  for (const f of approved) {
    blocks.push(`### Pipeline Feedback -- ${f.timestamp}`);
    blocks.push('');
    blocks.push(`**From ${f.sourceSkill} (step ${f.sourceStep}):**`);
    blocks.push('');
    blocks.push(f.content);
    blocks.push('');
  }
  const findingsText = blocks.join('\n');

  let updated: string;
  const headingRe = /^##\s+Pipeline\s+Feedback\s*$/im;
  const headingMatch = headingRe.exec(original);

  if (headingMatch) {
    // Find the next `## ` heading after the Pipeline Feedback heading and
    // insert the new block just before it; if there's no following heading,
    // append to the end of the file.
    const afterHeadingIdx = headingMatch.index + headingMatch[0].length;
    const rest = original.slice(afterHeadingIdx);
    const nextHeadingRe = /^##\s/m;
    const nextMatch = nextHeadingRe.exec(rest);
    if (nextMatch) {
      const insertAt = afterHeadingIdx + nextMatch.index;
      const before = original.slice(0, insertAt);
      const after = original.slice(insertAt);
      // Ensure a clean blank line between existing content and the new block.
      const sep = before.endsWith('\n') ? '' : '\n';
      updated = `${before}${sep}${findingsText}\n${after}`;
    } else {
      const sep = original.endsWith('\n') ? '' : '\n';
      updated = `${original}${sep}${findingsText}\n`;
    }
  } else {
    // No existing section — append a fresh one to the end of the file.
    const sep = original.endsWith('\n') || original === '' ? '' : '\n';
    updated = `${original}${sep}\n## Pipeline Feedback\n\n${findingsText}\n`;
  }

  try {
    writeFileSync(inputsPath, updated, 'utf8');
  } catch {
    return false;
  }
  return true;
}
