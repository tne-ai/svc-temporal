/**
 * Step execution activity — invokes a skill and runs the gate cascade.
 *
 * This is the primary activity called by the FsmProcessWorkflow for each step.
 * It combines skill invocation (invokeSkill) with quality gate validation
 * (runGateCascade) and implements the per-step retry loop.
 */

import { heartbeat } from '@temporalio/activity';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { StepExecutionParams, StepResult } from '../shared/types.js';
import { invokeSkill, buildPrompt } from './invokeSkill.js';
import { runGateCascade } from './runGateCascade.js';
import { resolveTemplateVars } from '../config/templateResolver.js';
import { buildManifestContent } from '../config/manifestGenerator.js';
import { emitEvent } from './emitEvent.js';

/** Regex matching inline/manual step names: "(gather inputs)" or "APPROVAL_GATE" */
const INLINE_STEP_RE = /^\(.*\)$|^[A-Z][A-Z0-9_]+$/;

/**
 * Execute a single step: invoke skill, run gate cascade, retry on failure.
 *
 * This activity heartbeats throughout to keep Temporal informed of progress.
 */
export async function executeStep(params: StepExecutionParams): Promise<StepResult> {
  const { step, iteration, templateVars, feedback, humanNotes, workspacePath, workingDir, manifestPath, manifestContent, config, state, currentStepKey, agentBackend, parentRunId, userId, s3Bucket, s3Prefix, phase, parallel, waveIdx } = params;

  heartbeat({ step: step.number, skill: step.skill, status: 'starting' });
  emitEvent(parentRunId, 'step_start', { stepNumber: step.number, skill: step.skill, iteration, phase, parallel, waveIdx });

  // Handle inline/manual steps
  if (INLINE_STEP_RE.test(step.skill)) {
    const result = handleInlineStep(step, iteration, templateVars);
    emitEvent(parentRunId, result.success ? 'step_complete' : 'step_failed', {
      stepNumber: step.number, skill: step.skill, iteration, inline: true,
      outputPath: result.outputPath, error: result.error,
    });
    return result;
  }

  // Compute a manifest of prior-step outputs if the workflow didn't pre-build
  // one. Paths in state.steps[*].outputPath are agent-cwd-relative, so we
  // resolve them against the agent's cwd root (workspacePath + workingDir)
  // to check file existence. Avoids process.chdir which would race with
  // concurrent activities on the same worker.
  let resolvedManifest = manifestContent || '';
  if (!resolvedManifest && state && config && currentStepKey) {
    const cwdRoot = workingDir ? join(workspacePath, workingDir) : workspacePath;
    try {
      resolvedManifest = buildManifestContent(state, config, currentStepKey, '', '', cwdRoot);
    } catch {
      // Non-fatal: manifest build shouldn't block step execution.
    }
  }

  // Build the prompt
  const prompt = buildPrompt(step, iteration, templateVars, feedback, humanNotes, manifestPath, resolvedManifest);

  // Retry loop (gate cascade may fail and require re-invocation)
  let retries = 0;
  let currentFeedback = feedback || '';

  while (true) {
    heartbeat({ step: step.number, skill: step.skill, status: 'invoking', retry: retries });
    emitEvent(parentRunId, 'heartbeat', { stepNumber: step.number, skill: step.skill, status: 'invoking', retry: retries });

    // Invoke the skill
    const invResult = await invokeSkill(step, prompt + (currentFeedback ? `\n\n## Revision Feedback\n\n${currentFeedback}` : ''), workspacePath, agentBackend, { parentRunId, userId, s3Bucket, s3Prefix, workingDir });

    if (!invResult.success) {
      // Check for stage review pause (nested orchestrator)
      if (invResult.stageReviewPause) {
        emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, reason: 'stage_review_pause' });
        return {
          success: false,
          error: 'Stage review pause from nested orchestrator',
          feedback: currentFeedback,
        };
      }

      const errMsg = invResult.stderr?.slice(0, 500) || 'Skill invocation failed';
      emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, error: errMsg });
      return {
        success: false,
        error: errMsg,
        feedback: currentFeedback,
      };
    }

    // Resolve output path. step.output is declared in SKILL.md and is always
    // relative to the agent's cwd, which is workspacePath/workingDir. The
    // existsSync check below was previously interpreting that relative path
    // against svc-temporal's process cwd — so even when the harness DID
    // write the file at the right location, executeStep saw it as missing
    // and silently fell through to "side-effect-only success". Resolve to
    // an absolute path here so existsSync and the gate cascade both look
    // in the right place.
    const cwdRoot = workingDir ? join(workspacePath, workingDir) : workspacePath;
    const outputPath = step.output
      ? resolveTemplateVars(step.output, templateVars).replace('{{ITER}}', String(iteration || 1))
      : '';
    const outputPathAbs = outputPath
      ? (isAbsolute(outputPath) ? outputPath : join(cwdRoot, outputPath))
      : '';

    // Run gate cascade if output file exists
    if (outputPathAbs && existsSync(outputPathAbs)) {
      heartbeat({ step: step.number, skill: step.skill, status: 'gate_check', retry: retries });
      emitEvent(parentRunId, 'gate_start', { stepNumber: step.number, skill: step.skill, iteration, outputPath });

      const cascadeResult = await runGateCascade(step, outputPathAbs, iteration, false, { workspacePath: cwdRoot });

      emitEvent(parentRunId, 'gate_result', {
        stepNumber: step.number, skill: step.skill, iteration, passed: cascadeResult.passed,
        gates: cascadeResult.gateResults.map(g => ({ gate: g.gateNumber, passed: g.passed, feedback: g.feedback.slice(0, 300) })),
      });

      if (cascadeResult.passed) {
        emitEvent(parentRunId, 'step_complete', { stepNumber: step.number, skill: step.skill, iteration, outputPath });
        return {
          success: true,
          outputPath,
          gateResults: Object.fromEntries(
            cascadeResult.gateResults.map(gr => [
              gr.gateNumber,
              gr.passed ? 'PASS' : `FAIL: ${gr.feedback.slice(0, 200)}`,
            ])
          ),
        };
      }

      // Infrastructure error → don't retry. Retrying the step won't make
      // the gate's evaluator reachable. Surface a distinct failure reason
      // so it's clear in the run history this wasn't a content problem.
      if (cascadeResult.infrastructureError) {
        emitEvent(parentRunId, 'step_failed', {
          stepNumber: step.number, skill: step.skill, iteration, retries,
          reason: 'gate_infrastructure_unavailable',
        });
        return {
          success: false,
          outputPath,
          error: 'Gate infrastructure unavailable — step output was written but could not be validated',
          feedback: cascadeResult.finalFeedback,
          gateResults: Object.fromEntries(
            cascadeResult.gateResults.map(gr => [
              gr.gateNumber,
              gr.passed ? 'PASS' : `FAIL: ${gr.feedback.slice(0, 200)}`,
            ])
          ),
        };
      }

      // Gate failed — retry if under limit
      retries++;
      if (retries < step.failFast.maxRetries) {
        currentFeedback = cascadeResult.finalFeedback;
        heartbeat({ step: step.number, skill: step.skill, status: 'retrying', retry: retries });
        emitEvent(parentRunId, 'heartbeat', { stepNumber: step.number, skill: step.skill, status: 'retrying', retry: retries });
        continue;
      }

      // Exhausted retries
      emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, retries, reason: 'gate_cascade_exhausted' });
      return {
        success: false,
        outputPath,
        error: `Failed gate cascade after ${retries} retries`,
        feedback: cascadeResult.finalFeedback,
        gateResults: Object.fromEntries(
          cascadeResult.gateResults.map(gr => [
            gr.gateNumber,
            gr.passed ? 'PASS' : `FAIL: ${gr.feedback.slice(0, 200)}`,
          ])
        ),
      };
    }

    // We didn't take the gate-cascade branch above — either no output is
    // declared (truly side-effect-only step like `git commit`), or output
    // IS declared but the file isn't on disk. Distinguish:
    //
    //   step.output is empty       → side-effect-only success
    //   step.output is declared but file missing → FAIL
    //
    // The previous "treat as success" path masked a real failure: when the
    // harness silently no-ops (model returns 0 tokens, an auth/model-name
    // error, or any other case where the Write tool never fires) the FSM
    // saw `outputPath && !existsSync(...)` and reported success anyway.
    // Result: green run, no output file, user sees nothing in the workspace
    // and no clue what went wrong. Now this fails loudly.
    if (step.output) {
      const reason = `Skill declared output '${outputPath}' but no file was written at '${outputPathAbs}'`;
      emitEvent(parentRunId, 'step_failed', {
        stepNumber: step.number,
        skill: step.skill,
        iteration,
        expectedOutput: outputPath,
        expectedOutputAbs: outputPathAbs,
        reason: 'output_file_missing',
        error: reason,
      });
      return {
        success: false,
        outputPath: outputPath || undefined,
        error: reason,
      };
    }

    // Truly side-effect-only (no output declared in SKILL.md).
    emitEvent(parentRunId, 'step_complete', {
      stepNumber: step.number,
      skill: step.skill,
      iteration,
      outputPath: outputPath || undefined,
      sideEffectOnly: true,
    });
    return { success: true, outputPath: outputPath || undefined };
  }
}

/**
 * Handle inline/manual steps — steps like "(gather inputs)" or "APPROVAL_GATE".
 * These are not real skills; the user creates the output file manually.
 */
function handleInlineStep(
  step: StepExecutionParams['step'],
  iteration: number,
  templateVars: Record<string, string>,
): StepResult {
  const outputPath = step.output
    ? resolveTemplateVars(step.output, templateVars).replace('{{ITER}}', String(iteration || 1))
    : '';

  if (outputPath && existsSync(outputPath)) {
    return { success: true, outputPath };
  }

  return {
    success: false,
    outputPath: outputPath || undefined,
    error: `Inline step '${step.skill}' requires manual output at: ${outputPath || '(no output path configured)'}`,
  };
}
