/**
 * Backprop-to-inputs — pure functions (no file I/O).
 *
 * Faithful port of the pure parts of the Python engine's
 * `backprop_inputs.py`. These run in BOTH workflow and activity code, so this
 * module must stay free of any Node imports (fs/path) to remain
 * Temporal-deterministic and workflow-bundleable. File-I/O counterparts
 * (scanOutputForFindings, applyFindingsToInputs) live in
 * `src/activities/backpropInputs.ts`.
 *
 * The engine scans skill outputs for `## Backprop to Inputs` sections and
 * evaluator feedback for `backprop_to_inputs: "..."` signals, collects them
 * as findings, and (when approved) appends them to the master inputs file.
 */

import type { InputFinding } from './types.js';

/**
 * Matches a `## Backprop to Inputs` section and captures its body up to the
 * next `## ` heading or end-of-file.
 *
 * Python:
 *   re.compile(
 *     r"^##\s+Backprop\s+to\s+Inputs\s*\n(.*?)(?=\n^##\s|\Z)",
 *     re.MULTILINE | re.DOTALL | re.IGNORECASE,
 *   )
 *
 * JS notes: `\Z` (end of string) → `$` under the `m` flag would match end of
 * line, so we anchor the trailing alternative on `\n##\s` or true end-of-input
 * `(?![\s\S])`. The `s` (dotAll) flag makes `.` span newlines like Python's
 * DOTALL; `m` enables `^` anchoring like MULTILINE; `i` for IGNORECASE.
 */
export const BACKPROP_SECTION_RE =
  /^##\s+Backprop\s+to\s+Inputs\s*\n([\s\S]*?)(?=\n^##\s|(?![\s\S]))/gim;

/**
 * Matches an evaluator `backprop_to_inputs: "..."` signal line, capturing the
 * (optionally quoted) value.
 *
 * Python:
 *   re.compile(
 *     r"backprop_to_inputs:\s*[\"']?(.+?)[\"']?\s*$",
 *     re.MULTILINE | re.IGNORECASE,
 *   )
 */
export const BACKPROP_INPUTS_SIGNAL_RE =
  /backprop_to_inputs:\s*["']?(.+?)["']?\s*$/gim;

/**
 * Scan evaluator feedback text for `backprop_to_inputs:` signals, one finding
 * per match. Pure — operates on the supplied string.
 *
 * Mirrors Python `scan_feedback_for_findings`.
 */
export function scanFeedbackForFindings(
  feedback: string,
  stepKey: string,
  skillName: string,
  timestamp: string,
): InputFinding[] {
  const findings: InputFinding[] = [];
  if (!feedback) return findings;
  // `matchAll` consumes the global regex without shared lastIndex state.
  for (const match of feedback.matchAll(BACKPROP_INPUTS_SIGNAL_RE)) {
    const content = (match[1] || '').trim();
    if (!content) continue;
    findings.push({
      sourceStep: stepKey,
      sourceSkill: skillName,
      content,
      timestamp,
      status: 'pending',
    });
  }
  return findings;
}

/**
 * Extract the body of a `## Backprop to Inputs` section from output text, if
 * present and non-empty. Pure helper shared by the file-reading activity.
 *
 * Mirrors the regex half of Python `scan_output_for_findings`.
 */
export function extractSectionFromOutput(output: string): string | null {
  if (!output) return null;
  // Reset is unnecessary with matchAll, but we only want the first section.
  for (const match of output.matchAll(BACKPROP_SECTION_RE)) {
    const content = (match[1] || '').trim();
    if (content) return content;
    return null;
  }
  return null;
}

/**
 * Render pending findings as a markdown review document.
 *
 * Mirrors Python `format_findings_for_review`.
 */
export function formatFindingsForReview(findings: InputFinding[]): string {
  const pending = findings.filter((f) => f.status === 'pending');
  const lines: string[] = [];
  lines.push('## Backprop to Inputs -- Review Required');
  lines.push('');
  lines.push(`${pending.length} pending finding(s) suggest updates to the master inputs file.`);
  lines.push('');
  pending.forEach((f, i) => {
    lines.push(`### Finding ${i + 1} (from ${f.sourceSkill}, step ${f.sourceStep})`);
    lines.push('');
    lines.push(f.content);
    lines.push('');
  });
  lines.push('**Options:**');
  lines.push('');
  lines.push('- [A] Apply all');
  lines.push('- [B] Apply selected');
  lines.push('- [C] Reject all');
  lines.push('- [D] Defer');
  lines.push('');
  return lines.join('\n');
}
