/**
 * Back-propagation of findings from downstream skills to the master inputs file.
 *
 * Port of the Python engine's `backprop_inputs.py` (tne-plugins) for svc-temporal
 * parity. Skills emit a `## Backprop to Inputs` section in their output;
 * evaluators use a `backprop_to_inputs: "..."` shorthand. The FSM collects these
 * findings, presents them for review, appends approved ones to the inputs file,
 * and triggers forward propagation so downstream steps re-run.
 *
 * The pure functions (parse/format/apply-to-content/mark) are exported for unit
 * tests; the file-I/O wrappers are Temporal activities (registered in index.ts).
 */
import { readFile, writeFile } from 'fs/promises';

export type FindingStatus = 'pending' | 'approved' | 'rejected' | 'applied';

export interface InputFinding {
  sourceStep: string;
  sourceSkill: string;
  content: string;
  timestamp: string;
  status: FindingStatus;
}

// ─── Pure logic (unit-tested) ────────────────────────────────────────────────

/**
 * Extract the body of a `## Backprop to Inputs` section: everything between that
 * heading and the next `## ` heading (or EOF), trimmed. Returns null if absent
 * or empty. Line-based (vs the Python regex) for clarity + robustness.
 */
export function parseBackpropSection(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Backprop\s+to\s+Inputs\s*$/i.test(l));
  if (start === -1) return null;
  const body: string[] = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j])) break;
    body.push(lines[j]);
  }
  const section = body.join('\n').trim();
  return section || null;
}

/** Parse `backprop_to_inputs: "..."` shorthand signals out of evaluator feedback. */
export function parseFeedbackSignals(feedback: string): string[] {
  const re = /backprop_to_inputs:\s*["']?(.+?)["']?\s*$/gim;
  const out: string[] = [];
  for (const m of feedback.matchAll(re)) {
    const text = (m[1] || '').trim();
    if (text) out.push(text);
  }
  return out;
}

export function scanOutputContentForFindings(
  content: string,
  stepKey: string,
  skillName: string,
  nowIso: string,
): InputFinding[] {
  const section = parseBackpropSection(content);
  if (!section) return [];
  return [{ sourceStep: stepKey, sourceSkill: skillName, content: section, timestamp: nowIso, status: 'pending' }];
}

export function scanFeedbackForFindings(
  feedback: string,
  stepKey: string,
  skillName: string,
  nowIso: string,
): InputFinding[] {
  return parseFeedbackSignals(feedback).map((content) => ({
    sourceStep: stepKey,
    sourceSkill: skillName,
    content,
    timestamp: nowIso,
    status: 'pending' as FindingStatus,
  }));
}

/** Markdown review block for the pending findings (mirrors the Python format). */
export function formatFindingsForReview(findings: InputFinding[]): string {
  const pending = findings.filter((f) => f.status === 'pending');
  if (pending.length === 0) return 'No pending findings to review.';
  const lines = [
    '## Backprop to Inputs -- Review Required',
    '',
    `**${pending.length} finding(s)** from downstream skills suggest changes to the master inputs file.`,
    '',
  ];
  pending.forEach((f, i) => {
    lines.push(`### Finding ${i + 1} (from ${f.sourceSkill}, step ${f.sourceStep})`, '', f.content, '');
  });
  lines.push(
    '---',
    '',
    '- **[A] Apply all** -- append all findings to inputs file',
    '- **[B] Apply selected** -- choose which findings to apply',
    '- **[C] Reject all** -- discard all findings',
    '- **[D] Defer** -- keep findings pending for later review',
  );
  return lines.join('\n');
}

/**
 * Pure transform: append the approved findings to the inputs-file `content`
 * under a `## Pipeline Feedback` section (inserting before the next heading if
 * the section already exists, else creating it). Returns the new content, or
 * null if there are no approved findings. `stampUtc` is "YYYY-MM-DD HH:MM:SS UTC".
 */
export function applyFindingsToContent(
  content: string,
  findings: InputFinding[],
  stampUtc: string,
): string | null {
  const approved = findings.filter((f) => f.status === 'approved');
  if (approved.length === 0) return null;
  const fbLines = ['', `### Pipeline Feedback -- ${stampUtc}`, ''];
  for (const f of approved) {
    fbLines.push(`**From ${f.sourceSkill} (step ${f.sourceStep}):**`, '', f.content, '');
  }
  const fbText = fbLines.join('\n');

  const pfMatch = /^## Pipeline Feedback\s*$/m.exec(content);
  if (pfMatch) {
    const after = content.slice(pfMatch.index + pfMatch[0].length);
    // Next heading that is NOT another "## Pipeline Feedback".
    const nxt = /\n## (?!Pipeline Feedback)/.exec(after);
    if (nxt) {
      const pos = pfMatch.index + pfMatch[0].length + nxt.index;
      return content.slice(0, pos) + fbText + content.slice(pos);
    }
    return content + fbText;
  }
  return content.replace(/\s+$/, '') + '\n\n## Pipeline Feedback\n' + fbText;
}

/**
 * Mark findings approved/rejected/applied. With no indices, marks ALL pending.
 * Indices refer to the position within the pending subset (matches Python).
 * Mutates in place (like the Python version).
 */
export function markFindings(findings: InputFinding[], status: FindingStatus, indices?: number[]): void {
  if (indices == null) {
    for (const f of findings) if (f.status === 'pending') f.status = status;
    return;
  }
  const pending = findings.filter((f) => f.status === 'pending');
  for (const i of indices) if (i >= 0 && i < pending.length) pending[i].status = status;
}

// ─── Temporal activities (file I/O) ──────────────────────────────────────────

/** Scan a skill output FILE for a backprop-to-inputs section. */
export async function scanOutputForFindings(params: {
  outputPath: string;
  stepKey: string;
  skillName: string;
}): Promise<InputFinding[]> {
  let content: string;
  try {
    content = await readFile(params.outputPath, 'utf-8');
  } catch {
    return [];
  }
  return scanOutputContentForFindings(content, params.stepKey, params.skillName, new Date().toISOString());
}

/** Append approved findings to the inputs FILE. Returns true if it was modified. */
export async function applyFindingsToInputs(params: {
  inputsPath: string;
  findings: InputFinding[];
}): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(params.inputsPath, 'utf-8');
  } catch {
    return false;
  }
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const next = applyFindingsToContent(content, params.findings, stamp);
  if (next == null) return false;
  await writeFile(params.inputsPath, next, 'utf-8');
  return true;
}
