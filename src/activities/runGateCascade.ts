/**
 * Fail-fast quality cascade for step outputs.
 *
 * Ported from tne-plugins/plugins/tne/engine/gates.py.
 *
 * Gate cascade (all enabled by default):
 *   Step output → Gate 1 (type-specific) → PASS? done
 *                                         → FAIL? retry step
 *                → Gate 2 (self-eval)     → PASS? done
 *                                         → FAIL? retry step
 *                → Gate 3 (persona)       → PASS? done
 *                                         → FAIL? retry step
 *                → Gate 4 (counsel)       → PASS? done
 *                                         → FAIL? retry or abort
 */

import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { heartbeat } from '@temporalio/activity';
import type { Step, GateResult, CascadeResult } from '../shared/types.js';
import { StageType } from '../shared/types.js';
import { GATE_ACTIVITY_TIMEOUT } from '../shared/constants.js';

const GATE_TIMEOUT_MS = 300_000; // 5 minutes

const JSON_SUFFIX = '\n\nReturn ONLY valid JSON (no markdown fencing):\n' +
  '{"passed": true/false, "feedback": "...", "score": <number>}';

/**
 * Run the full gate cascade on a step's output.
 * Runs gates sequentially; passes at any gate → skip remaining.
 */
export async function runGateCascade(
  step: Step,
  outputPath: string,
  iteration = 0,
  dryRun = false,
): Promise<CascadeResult> {
  const enabledGates = step.failFast.gates;

  if (!existsSync(outputPath)) {
    return {
      passed: false,
      gateResults: [{
        gateNumber: 0,
        passed: false,
        feedback: `Output file does not exist: ${outputPath}`,
      }],
      finalFeedback: `Output file does not exist: ${outputPath}`,
    };
  }

  const results: GateResult[] = [];

  for (const gateNum of [...enabledGates].sort()) {
    if (dryRun) {
      return {
        passed: true,
        gateResults: [{ gateNumber: gateNum, passed: true, feedback: '[DRY RUN]' }],
        finalFeedback: '',
      };
    }

    heartbeat({ status: 'gate_check', gate: gateNum });

    const result = runGate(gateNum, step, outputPath);
    results.push(result);

    if (result.passed) {
      return { passed: true, gateResults: results, finalFeedback: '' };
    }
  }

  const allFeedback = results
    .filter(r => !r.passed)
    .map(r => `Gate ${r.gateNumber}: ${r.feedback}`)
    .join('\n\n');

  return { passed: false, gateResults: results, finalFeedback: allFeedback };
}

function runGate(gateNum: number, step: Step, outputPath: string): GateResult {
  switch (gateNum) {
    case 1: return runGate1(step, outputPath);
    case 2: return runGate2(step, outputPath);
    case 3: return runGate3(step, outputPath);
    case 4: return runGate4(step, outputPath);
    default: return { gateNumber: gateNum, passed: true, feedback: 'Unknown gate — auto-pass' };
  }
}

// ─── Gate 1: Type-specific validation ───────────────────────────────────────

function runGate1(step: Step, outputPath: string): GateResult {
  if (step.stageType === StageType.CREATIVE) {
    return { gateNumber: 1, passed: true, feedback: 'Creative content — Gate 1 auto-pass' };
  }

  if (step.stageType === StageType.FACT_SEARCH) {
    return invokeClaudeGate(
      `Execute /r-cao1-skeptics-and-citations on the file ${outputPath}. ` +
      'Verify all factual claims have citations.',
      1,
    );
  }

  if (step.stageType === StageType.CODE) {
    try {
      const content = readFileSync(outputPath, 'utf-8');
      if (!content.trim()) {
        return { gateNumber: 1, passed: false, feedback: 'Code output is empty' };
      }
      return { gateNumber: 1, passed: true, feedback: 'Code check passed (non-empty)' };
    } catch {
      return { gateNumber: 1, passed: false, feedback: 'Could not read output file' };
    }
  }

  // analysis or default → structure check
  return gate1StructureCheck(outputPath);
}

function gate1StructureCheck(outputPath: string): GateResult {
  try {
    const content = readFileSync(outputPath, 'utf-8');
    const issues: string[] = [];

    if (!content.includes('##') && !content.includes('# ')) {
      issues.push('No section headers found');
    }
    if (content.split(/\s+/).length < 50) {
      issues.push(`Very short output (${content.split(/\s+/).length} words)`);
    }

    if (issues.length === 0) {
      return { gateNumber: 1, passed: true, feedback: 'Structure check passed' };
    }
    return { gateNumber: 1, passed: false, feedback: 'Structure issues: ' + issues.join('; ') };
  } catch {
    return { gateNumber: 1, passed: false, feedback: 'Could not read output file' };
  }
}

// ─── Gates 2-4: LLM-based evaluation ───────────────────────────────────────

function runGate2(step: Step, outputPath: string): GateResult {
  const passCondition = step.passCondition ||
    'Output is complete, coherent, and addresses all requirements';
  return invokeClaudeGate(
    `You are evaluating the output of skill '${step.skill}'.\n\n` +
    `Output file: ${outputPath}\n` +
    `Read the file and evaluate against this pass condition:\n` +
    passCondition,
    2,
  );
}

function runGate3(step: Step, outputPath: string): GateResult {
  const cfg = step.failFast.persona as Record<string, string> | undefined;
  const name = cfg?.['name'] || 'Senior Domain Expert';
  const dims = cfg?.['dimensions'] || 'quality, completeness, accuracy, clarity, actionability';
  const threshold = cfg?.['threshold'] || '7';
  return invokeClaudeGate(
    `Execute /cko10-persona-evaluator with:\n` +
    `  CONTENT_FILE=${outputPath}\n` +
    `  PERSONA=${name}\n` +
    `  DIMENSIONS=${dims}\n` +
    `  THRESHOLD=${threshold}\n` +
    `  SKILL=${step.skill}`,
    3,
  );
}

function runGate4(step: Step, outputPath: string): GateResult {
  const cfg = step.failFast.counselPersonas as Record<string, string> | undefined;
  const personas = cfg?.['members'] || '3 domain experts with diverse perspectives';
  const chairman = cfg?.['chairman'] || 'auto';
  const threshold = cfg?.['threshold'] || '7';
  return invokeClaudeGate(
    `Execute /cai6-ai-counsel with:\n` +
    `  CONTENT_FILE=${outputPath}\n` +
    `  PERSONAS=${personas}\n` +
    `  CHAIRMAN=${chairman}\n` +
    `  THRESHOLD=${threshold}\n` +
    `  SKILL=${step.skill}`,
    4,
  );
}

// ─── Shared invocation + JSON extraction ────────────────────────────────────

function invokeClaudeGate(prompt: string, gateNumber: number): GateResult {
  try {
    const result = execFileSync('claude', ['-p', '--output-format', 'text'], {
      input: prompt + JSON_SUFFIX,
      timeout: GATE_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = extractJson(result);
    if (!parsed) {
      return {
        gateNumber,
        passed: false,
        feedback: `Could not parse gate result as JSON: ${result.slice(0, 300)}`,
      };
    }

    return {
      gateNumber,
      passed: Boolean(parsed['passed']),
      feedback: String(parsed['feedback'] || ''),
      score: typeof parsed['score'] === 'number' ? parsed['score'] : undefined,
    };
  } catch (err: any) {
    if (err.killed) {
      return { gateNumber, passed: false, feedback: `Gate ${gateNumber} timed out`, error: 'timeout' };
    }
    return { gateNumber, passed: false, feedback: String(err), error: String(err) };
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  text = text.trim();

  // Strip markdown fencing
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1].trim() === '```') lines.pop();
    text = lines.join('\n').trim();
  }

  try {
    return JSON.parse(text);
  } catch { /* try regex fallback */ }

  const match = text.match(/\{[^{}]*\}/s);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* give up */ }
  }

  return null;
}
