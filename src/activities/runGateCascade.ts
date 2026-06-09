/**
 * Fail-fast quality cascade for step outputs.
 *
 * Ported from tne-plugins/plugins/tne/engine/gates.py.
 *
 * Gate cascade (all enabled by default):
 *   Step output → Gate 1 (type-specific) → PASS? done
 *                                         → FAIL? next gate
 *                → Gate 2 (self-eval)     → PASS? done
 *                                         → FAIL? next gate
 *                → Gate 3 (persona)       → PASS? done
 *                                         → FAIL? next gate
 *                → Gate 4 (counsel)       → PASS? done
 *                                         → FAIL? caller retries
 *
 * Implementation notes
 * ────────────────────
 * Gates 2-4 are LLM-driven evaluations. Originally they shelled out to
 * `claude -p` via execFileSync, which:
 *   - depended on the `claude` CLI being installed and authenticated in
 *     the worker environment
 *   - inherited whatever ANTHROPIC_BASE_URL / AUTH_TOKEN the worker
 *     happened to have, so a step that ran on OpenRouter (Kimi etc.) and
 *     mutated those vars could poison the gate's CLI
 *   - bound the gate model to the user's chat/step model selection,
 *     which made gates run on Kimi when the user picked Kimi
 *
 * We now invoke the Claude Agent SDK in-process for gates. The gate
 * model is fixed (env GATE_MODEL, default `claude-haiku-4-5-20251001`)
 * so the user's step model choice doesn't affect validation. The SDK
 * picks up auth from env (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)
 * the same way step invocations do — no CLI dependency.
 *
 * Errors thrown by the SDK (network, init, auth) are surfaced as
 * `error: 'infrastructure'` results so the cascade can short-circuit
 * remaining gates and tell executeStep to skip retries.
 */

import { readFileSync, existsSync } from 'fs';
import { heartbeat } from '@temporalio/activity';
import type { Step, GateResult, CascadeResult } from '../shared/types.js';
import { StageType } from '../shared/types.js';
import { withWallClockHeartbeat } from './heartbeatTicker.js';
import { roleModel } from '../config/llmCliConfig.js';

const JSON_SUFFIX = '\n\nReturn ONLY valid JSON (no markdown fencing):\n' +
  '{"passed": true/false, "feedback": "...", "score": <number>}';

/** Gate model is fixed independent of the step model. Resolution order:
 *    1. GATE_MODEL env override
 *    2. llm-cli.yaml `similarity` role (the engine's scalar-scoring role,
 *       the equivalent of gates) — parity with the Python engine
 *    3. hardcoded default
 */
const GATE_MODEL = process.env.GATE_MODEL?.trim() || roleModel('similarity') || 'claude-haiku-4-5-20251001';

/** Per-gate maxTurns. Gates only need to read one file and emit JSON;
 *  more than ~5 turns means the model is wandering. */
const GATE_MAX_TURNS = 5;

interface GateContext {
  /** Workspace root passed through from executeStep so the harness has a
   *  real cwd to resolve Read tool paths against. */
  workspacePath?: string;
}

/**
 * Run the full gate cascade on a step's output.
 * Runs gates sequentially; passes at any gate → skip remaining.
 */
export async function runGateCascade(
  step: Step,
  outputPath: string,
  iteration = 0,
  dryRun = false,
  ctx?: GateContext,
): Promise<CascadeResult> {
  // Wall-clock heartbeat: each gate is an LLM call (~10-60s on Haiku) and
  // a stall there used to be enough to blow past heartbeatTimeout.
  return withWallClockHeartbeat(
    () => ({ status: 'gate_cascade_tick', step: step.number }),
    () => runGateCascadeInner(step, outputPath, iteration, dryRun, ctx),
  );
}

async function runGateCascadeInner(
  step: Step,
  outputPath: string,
  iteration = 0,
  dryRun = false,
  ctx?: GateContext,
): Promise<CascadeResult> {
  // iteration is part of the public API but not used here directly —
  // emit-event callers thread it through for logging.
  void iteration;
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

    const result = await runGate(gateNum, step, outputPath, ctx);
    results.push(result);

    if (result.passed) {
      return { passed: true, gateResults: results, finalFeedback: '' };
    }

    // Short-circuit on infrastructure errors. If gate N couldn't reach
    // its evaluator, gate N+1 won't either — and executeStep retrying
    // the whole step won't fix the infra. Bail out and surface clearly.
    if (result.error === 'infrastructure') {
      return {
        passed: false,
        gateResults: results,
        finalFeedback: `Gate infrastructure unavailable: ${result.feedback}. Skipping remaining gates.`,
        infrastructureError: true,
      };
    }
  }

  const allFeedback = results
    .filter(r => !r.passed)
    .map(r => `Gate ${r.gateNumber}: ${r.feedback}`)
    .join('\n\n');

  return { passed: false, gateResults: results, finalFeedback: allFeedback };
}

async function runGate(
  gateNum: number,
  step: Step,
  outputPath: string,
  ctx?: GateContext,
): Promise<GateResult> {
  switch (gateNum) {
    case 1: return runGate1(step, outputPath, ctx);
    case 2: return runGate2(step, outputPath, ctx);
    case 3: return runGate3(step, outputPath, ctx);
    case 4: return runGate4(step, outputPath, ctx);
    default: return { gateNumber: gateNum, passed: true, feedback: 'Unknown gate — auto-pass' };
  }
}

// ─── Gate 1: Type-specific validation ───────────────────────────────────────

async function runGate1(
  step: Step,
  outputPath: string,
  ctx?: GateContext,
): Promise<GateResult> {
  if (step.stageType === StageType.CREATIVE) {
    return { gateNumber: 1, passed: true, feedback: 'Creative content — Gate 1 auto-pass' };
  }

  if (step.stageType === StageType.FACT_SEARCH) {
    return invokeHarnessGate(
      `Execute /r-cao1-skeptics-and-citations on the file ${outputPath}. ` +
      'Verify all factual claims have citations.',
      1,
      ctx,
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

    // Just require non-empty content. The previous "≥ 50 words" heuristic
    // wrongly failed legitimately-tiny skill outputs (e.g. p-debug2 emits
    // a 3-item list intentionally). Gates 2-4 are the LLM-driven content
    // judges; gate 1 is just a "did anything get written" guard.
    if (!content.trim()) {
      return { gateNumber: 1, passed: false, feedback: 'Output file is empty' };
    }

    return { gateNumber: 1, passed: true, feedback: 'Structure check passed (non-empty)' };
  } catch {
    return { gateNumber: 1, passed: false, feedback: 'Could not read output file' };
  }
}

// ─── Gates 2-4: LLM-based evaluation ───────────────────────────────────────

async function runGate2(
  step: Step,
  outputPath: string,
  ctx?: GateContext,
): Promise<GateResult> {
  const passCondition = step.passCondition ||
    'Output is complete, coherent, and addresses all requirements';
  return invokeHarnessGate(
    `You are evaluating the output of skill '${step.skill}'.\n\n` +
    `Output file: ${outputPath}\n` +
    `Read the file and evaluate against this pass condition:\n` +
    passCondition,
    2,
    ctx,
  );
}

async function runGate3(
  step: Step,
  outputPath: string,
  ctx?: GateContext,
): Promise<GateResult> {
  const cfg = step.failFast.persona as Record<string, string> | undefined;
  const name = cfg?.['name'] || 'Senior Domain Expert';
  const dims = cfg?.['dimensions'] || 'quality, completeness, accuracy, clarity, actionability';
  const threshold = cfg?.['threshold'] || '7';
  return invokeHarnessGate(
    `Execute /cko10-persona-evaluator with:\n` +
    `  CONTENT_FILE=${outputPath}\n` +
    `  PERSONA=${name}\n` +
    `  DIMENSIONS=${dims}\n` +
    `  THRESHOLD=${threshold}\n` +
    `  SKILL=${step.skill}`,
    3,
    ctx,
  );
}

async function runGate4(
  step: Step,
  outputPath: string,
  ctx?: GateContext,
): Promise<GateResult> {
  const cfg = step.failFast.counselPersonas as Record<string, string> | undefined;
  const personas = cfg?.['members'] || '3 domain experts with diverse perspectives';
  const chairman = cfg?.['chairman'] || 'auto';
  const threshold = cfg?.['threshold'] || '7';
  return invokeHarnessGate(
    `Execute /cai6-ai-counsel with:\n` +
    `  CONTENT_FILE=${outputPath}\n` +
    `  PERSONAS=${personas}\n` +
    `  CHAIRMAN=${chairman}\n` +
    `  THRESHOLD=${threshold}\n` +
    `  SKILL=${step.skill}`,
    4,
    ctx,
  );
}

// ─── Shared invocation + JSON extraction ────────────────────────────────────

/**
 * Invoke a gate via the in-process agent-harness. Pinned to a fixed gate
 * model so the user's step-model choice doesn't bleed into validation.
 *
 * Throws caught here become `error: 'infrastructure'` results — this
 * signals to the cascade and to executeStep that the failure was not
 * about content, so retrying won't help.
 */
async function invokeHarnessGate(
  prompt: string,
  gateNumber: number,
  ctx?: GateContext,
): Promise<GateResult> {
  try {
    // Gate evaluation runs through the Claude Agent SDK directly — we
    // only need a single-turn evaluation, with the Read tool available
    // so the gate can inspect the step's output file. Auth comes from
    // the worker env (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN), the
    // same way step invocations resolve it.
    const { createClaudeSDKAgent } = await import('../services/claudeSdkAgent.js');
    const agent = createClaudeSDKAgent({
      model: GATE_MODEL,
      cwd: ctx?.workspacePath || process.cwd(),
      permissionMode: 'bypassPermissions',
      maxTurns: GATE_MAX_TURNS,
      allowedTools: ['Read'],
    });

    let text = '';
    for await (const event of agent.query(prompt + JSON_SUFFIX)) {
      const ev = event as any;
      if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
        }
      } else if (ev?.type === 'result' && typeof ev.result === 'string' && !text) {
        // Some flows set the final text on the result event rather than
        // an assistant block. Use it as a fallback.
        text = ev.result;
      }
    }

    const parsed = extractJson(text);
    if (!parsed) {
      // Model produced something but it wasn't parsable JSON. Treat as
      // a content failure (model didn't follow instructions), not infra.
      return {
        gateNumber,
        passed: false,
        feedback: `Could not parse gate result as JSON: ${text.slice(0, 300)}`,
      };
    }

    return {
      gateNumber,
      passed: Boolean(parsed['passed']),
      feedback: String(parsed['feedback'] || ''),
      score: typeof parsed['score'] === 'number' ? parsed['score'] : undefined,
    };
  } catch (err: any) {
    // Anything thrown from createClaudeSDKAgent / query is treated as
    // an infrastructure problem: SDK couldn't initialize, network
    // error, auth rejection, model not reachable, etc. None of these
    // get better by retrying the step.
    const msg = err?.message || String(err);
    return {
      gateNumber,
      passed: false,
      feedback: `Gate ${gateNumber} infrastructure error: ${msg}`,
      error: 'infrastructure',
    };
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
