/**
 * Step execution activity — invokes a skill and runs the gate cascade.
 *
 * This is the primary activity called by the FsmProcessWorkflow for each step.
 * It combines skill invocation (invokeSkill) with quality gate validation
 * (runGateCascade) and implements the per-step retry loop.
 */

import { heartbeat } from '@temporalio/activity';
import { existsSync } from 'fs';
import type { StepExecutionParams, StepResult } from '../shared/types.js';
import { invokeSkill, buildPrompt } from './invokeSkill.js';
import { runGateCascade } from './runGateCascade.js';
import { resolveTemplateVars } from '../config/templateResolver.js';

/** Regex matching inline/manual step names: "(gather inputs)" or "APPROVAL_GATE" */
const INLINE_STEP_RE = /^\(.*\)$|^[A-Z][A-Z0-9_]+$/;

/**
 * Execute a single step: invoke skill, run gate cascade, retry on failure.
 *
 * This activity heartbeats throughout to keep Temporal informed of progress.
 */
export async function executeStep(params: StepExecutionParams): Promise<StepResult> {
  const { step, iteration, templateVars, feedback, humanNotes, workspacePath, manifestPath } = params;

  heartbeat({ step: step.number, skill: step.skill, status: 'starting' });

  // Handle inline/manual steps
  if (INLINE_STEP_RE.test(step.skill)) {
    return handleInlineStep(step, iteration, templateVars);
  }

  // Build the prompt
  const prompt = buildPrompt(step, iteration, templateVars, feedback, humanNotes, manifestPath);

  // Retry loop (gate cascade may fail and require re-invocation)
  let retries = 0;
  let currentFeedback = feedback || '';

  while (true) {
    heartbeat({ step: step.number, skill: step.skill, status: 'invoking', retry: retries });

    // Invoke the skill
    const invResult = await invokeSkill(step, prompt + (currentFeedback ? `\n\n## Revision Feedback\n\n${currentFeedback}` : ''));

    if (!invResult.success) {
      // Check for stage review pause (nested orchestrator)
      if (invResult.stageReviewPause) {
        return {
          success: false,
          error: 'Stage review pause from nested orchestrator',
          feedback: currentFeedback,
        };
      }

      return {
        success: false,
        error: invResult.stderr?.slice(0, 500) || 'Skill invocation failed',
        feedback: currentFeedback,
      };
    }

    // Resolve output path
    const outputPath = step.output
      ? resolveTemplateVars(step.output, templateVars).replace('{{ITER}}', String(iteration || 1))
      : '';

    // Run gate cascade if output file exists
    if (outputPath && existsSync(outputPath)) {
      heartbeat({ step: step.number, skill: step.skill, status: 'gate_check', retry: retries });

      const cascadeResult = await runGateCascade(step, outputPath, iteration);

      if (cascadeResult.passed) {
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

      // Gate failed — retry if under limit
      retries++;
      if (retries < step.failFast.maxRetries) {
        currentFeedback = cascadeResult.finalFeedback;
        heartbeat({ step: step.number, skill: step.skill, status: 'retrying', retry: retries });
        continue;
      }

      // Exhausted retries
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

    // No output path or output doesn't exist — treat as success
    // (some steps are side-effect-only, e.g., git commit)
    return {
      success: true,
      outputPath: outputPath || undefined,
    };
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
