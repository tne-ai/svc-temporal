/**
 * Step execution activity — invokes a skill and runs the gate cascade.
 *
 * This is the primary activity called by the FsmProcessWorkflow for each step.
 * It combines skill invocation (invokeSkill) with quality gate validation
 * (runGateCascade) and implements the per-step retry loop.
 */

import { heartbeat } from '@temporalio/activity';
import { execFileSync, spawn } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
import { tmpdir } from 'os';
import type { StepExecutionParams, StepResult } from '../shared/types.js';
import { invokeSkill, buildPrompt } from './invokeSkill.js';
import { runGateCascade } from './runGateCascade.js';
import { resolveTemplateVars } from '../config/templateResolver.js';
import { buildManifestContent } from '../config/manifestGenerator.js';
import { emitEvent } from './emitEvent.js';
import { withWallClockHeartbeat } from './heartbeatTicker.js';

/** Regex matching inline/manual step names: "(gather inputs)" or "APPROVAL_GATE" */
const INLINE_STEP_RE = /^\(.*\)$|^[A-Z][A-Z0-9_]+$/;

function isCommandStep(step: StepExecutionParams['step']): boolean {
  return (step.run || '').trim().toLowerCase() === 'command';
}

function commandFromStep(step: StepExecutionParams['step']): string {
  return step.notes || step.skill || '';
}

function commandRequiresPath(command: string): string | null {
  const match = command.match(/(?:^|\s)(?:python3?|node|bash|sh)\s+([^\s;&|]+plugins\/tne\/skills\/[^\s;&|]+)/);
  return match?.[1]?.replace(/^['"]|['"]$/g, '') || null;
}

function findBundledTnePluginsRoot(requiredRelativePath?: string | null): string | null {
  const candidates = [
    process.env.TNE_PLUGINS_PATH,
    join(process.cwd(), 'tne-plugins'),
    join(process.cwd(), '..', 'tne-plugins'),
    '/app/tne-plugins',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (!existsSync(join(candidate, 'plugins', 'tne', 'skills'))) continue;
    if (requiredRelativePath && !existsSync(join(candidate, requiredRelativePath))) continue;
    return candidate;
  }
  return null;
}

function copyTnePluginsTree(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => {
      const rel = src.slice(source.length).replace(/^[/\\]+/, '');
      if (!rel) return true;
      const parts = rel.split(/[/\\]+/);
      return !parts.some((part) => part === '.git' || part === 'node_modules' || part === '.venv' || part === '__pycache__');
    },
  });
}

function cloneTnePlugins(destination: string): boolean {
  if (process.env.SVC_TEMPORAL_DISABLE_TNE_PLUGINS_CLONE === 'true') return false;
  const repoUrl = process.env.TNE_PLUGINS_REPO_URL || 'https://github.com/tne-ai/tne-plugins.git';
  const ref = process.env.TNE_PLUGINS_REF || 'main';
  const tmp = mkdtempSync(join(tmpdir(), 'tne-plugins-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', ref, repoUrl, tmp], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    });
    copyTnePluginsTree(tmp, destination);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function ensureCommandWorkingDir(workspacePath: string, workingDir: string | undefined, cwdRoot: string, command = ''): void {
  mkdirSync(cwdRoot, { recursive: true });
  if (!workingDir) return;
  // Command-mode deterministic skills often execute repository-relative scripts
  // such as `python3 plugins/tne/skills/...`. Central Temporal workers receive
  // an S3 workspace that may contain only the scoped working directory outputs,
  // not a full tne-plugins checkout. Seed the requested workingDir from a known
  // good source, and if the image bundled stale plugins, fetch current plugins
  // directly instead of burning another rollout cycle.
  if (basename(workingDir) !== 'tne-plugins') return;

  const requiredRelativePath = commandRequiresPath(command);
  const hasRequiredPath = () => !requiredRelativePath || existsSync(join(cwdRoot, requiredRelativePath));
  if (existsSync(join(cwdRoot, 'plugins', 'tne', 'skills')) && hasRequiredPath()) return;

  const bundled = findBundledTnePluginsRoot(requiredRelativePath) || findBundledTnePluginsRoot();
  if (bundled) copyTnePluginsTree(bundled, cwdRoot);
  if (hasRequiredPath()) return;

  // Last-resort self-healing path for exactly the failure mode that caused the
  // CRM loop: svc-temporal was rolled out with fresh worker code but stale
  // bundled tne-plugins. The worker has git/network; fetch current plugins into
  // the workspace so command-mode steps can proceed immediately.
  cloneTnePlugins(cwdRoot);
}

function runShellCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: stderr + String(err) }));
  });
}

/**
 * Snapshot mtimes of a step's output + declared inputs at "step complete"
 * time. Recorded values flow back into `StepState.outputMtime` /
 * `StepState.inputMtimes` and feed `checkFreshness` on workflow resume.
 *
 * Conservatively returns whatever files actually exist on disk — missing
 * inputs are simply omitted so a step that didn't read every declared
 * input doesn't accidentally invalidate itself forever.
 */
function snapshotMtimes(
  inputs: string[],
  cwdRoot: string,
  outputPathAbs: string | undefined,
): { outputMtime?: number; inputMtimes: Record<string, number> } {
  let outputMtime: number | undefined;
  if (outputPathAbs && existsSync(outputPathAbs)) {
    try {
      outputMtime = statSync(outputPathAbs).mtimeMs;
    } catch {
      // ignore — missing/unreadable just means we don't track it
    }
  }
  const inputMtimes: Record<string, number> = {};
  for (const inp of inputs || []) {
    if (!inp) continue;
    const inpAbs = isAbsolute(inp) ? inp : join(cwdRoot, inp);
    if (!existsSync(inpAbs)) continue;
    try {
      inputMtimes[inp] = statSync(inpAbs).mtimeMs;
    } catch {
      // ignore
    }
  }
  return { outputMtime, inputMtimes };
}

/**
 * Execute a single step: invoke skill, run gate cascade, retry on failure.
 *
 * This activity heartbeats throughout to keep Temporal informed of progress.
 */
export async function executeStep(params: StepExecutionParams): Promise<StepResult> {
  const { step, iteration, templateVars, feedback, humanNotes, workspacePath, workingDir, manifestPath, manifestContent, config, state, currentStepKey, agentBackend, parentRunId, userId, s3Bucket, s3Prefix, phase, parallel, waveIdx } = params;

  // Wall-clock heartbeat ticker for the entire step. Without this, a stall
  // anywhere inside invokeSkill / runGateCascade (cold worker pod, mid-LLM
  // hang, slow tool call, init-time S3 sync) that exceeds the activity's
  // heartbeatTimeout will kill the step even though it's still healthy.
  return withWallClockHeartbeat(
    () => ({ step: step.number, skill: step.skill, status: 'tick' }),
    () => executeStepInner(params),
  );
}

async function executeStepInner(params: StepExecutionParams): Promise<StepResult> {
  const { step, iteration, templateVars, feedback, humanNotes, workspacePath, workingDir, manifestPath, manifestContent, config, state, currentStepKey, agentBackend, toolHarness, parentRunId, userId, s3Bucket, s3Prefix, phase, parallel, waveIdx } = params;

  heartbeat({ step: step.number, skill: step.skill, status: 'starting' });
  emitEvent(parentRunId, 'step_start', { stepNumber: step.number, skill: step.skill, iteration, phase, parallel, waveIdx });

  const cwdRoot = workingDir ? join(workspacePath, workingDir) : workspacePath;

  if (isCommandStep(step)) {
    try { ensureCommandWorkingDir(workspacePath, workingDir, cwdRoot, commandFromStep(step)); } catch (err: any) {
      const error = `Failed to prepare command working directory '${cwdRoot}': ${err?.message || String(err)}`;
      emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, error });
      return { success: false, error };
    }
  }

  // Deterministic command-mode steps execute the declared shell command directly
  // instead of routing through an LLM agent. Dict-form SOPs use `run: command`
  // with `skill: inline` and put the command in the step description. Treating
  // those as manual inline steps made the workflow complete without ever running
  // the command or writing the declared output artifact.
  if (isCommandStep(step)) {
    const command = commandFromStep(step).trim();
    const outputPath = step.output
      ? resolveTemplateVars(step.output, templateVars).replace('{{ITER}}', String(iteration || 1))
      : '';
    const outputPathAbs = outputPath
      ? (isAbsolute(outputPath) ? outputPath : join(cwdRoot, outputPath))
      : '';
    const stateOutputPath = outputPath && !isAbsolute(outputPath) && workingDir
      ? join(workingDir, outputPath)
      : outputPath;
    if (!command) {
      const error = 'Command-mode step has no command text.';
      emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, outputPath: stateOutputPath || outputPath, error });
      return { success: false, outputPath: stateOutputPath || outputPath || undefined, error };
    }
    emitEvent(parentRunId, 'heartbeat', { stepNumber: step.number, skill: step.skill, status: 'command_running', iteration, command: command.slice(0, 300), outputPath: stateOutputPath || outputPath || undefined });
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(templateVars || {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = String(value);
    }
    const commandResult = await runShellCommand(command, cwdRoot, env);
    if (commandResult.exitCode !== 0) {
      const error = (commandResult.stderr || commandResult.stdout || `Command exited ${commandResult.exitCode}`).slice(0, 2000);
      emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, outputPath: stateOutputPath || outputPath || undefined, error, exitCode: commandResult.exitCode });
      return { success: false, outputPath: stateOutputPath || outputPath || undefined, error };
    }
    if (outputPathAbs && !existsSync(outputPathAbs)) {
      const error = `Command-mode step declared output '${outputPath}' but no file was written at '${outputPathAbs}'`;
      emitEvent(parentRunId, 'step_failed', { stepNumber: step.number, skill: step.skill, iteration, outputPath: stateOutputPath || outputPath || undefined, error, stdout: commandResult.stdout.slice(0, 1000) });
      return { success: false, outputPath: stateOutputPath || outputPath || undefined, error };
    }
    const mt = snapshotMtimes(step.inputs, cwdRoot, outputPathAbs || undefined);
    emitEvent(parentRunId, 'step_complete', { stepNumber: step.number, skill: step.skill, iteration, outputPath: stateOutputPath || outputPath || undefined, command: true });
    return {
      success: true,
      outputPath: stateOutputPath || outputPath || undefined,
      outputMtime: mt.outputMtime,
      inputMtimes: mt.inputMtimes,
    };
  }

  // Handle inline/manual steps
  if (INLINE_STEP_RE.test(step.skill)) {
    const result = handleInlineStep(step, iteration, templateVars, cwdRoot);
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
    const invResult = await invokeSkill(step, prompt + (currentFeedback ? `\n\n## Revision Feedback\n\n${currentFeedback}` : ''), workspacePath, agentBackend, { parentRunId, userId, s3Bucket, s3Prefix, workingDir, toolHarness });

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
    const outputPath = step.output
      ? resolveTemplateVars(step.output, templateVars).replace('{{ITER}}', String(iteration || 1))
      : '';
    const outputPathAbs = outputPath
      ? (isAbsolute(outputPath) ? outputPath : join(cwdRoot, outputPath))
      : '';

    // Structured Outputs: when the leaf skill declared output_schema_path,
    // invokeSkill returns the constrained-decoded JSON payload directly.
    // Write it as the step's output file ourselves — the agent may also have
    // written something there, but the structured output is the source of
    // truth and overwrites it. This guarantees the file matches the schema
    // even if the agent's Write tool produced something slightly different.
    if (invResult.structuredOutput !== undefined && outputPathAbs) {
      try {
        mkdirSync(dirname(outputPathAbs), { recursive: true });
        writeFileSync(outputPathAbs, JSON.stringify(invResult.structuredOutput, null, 2), 'utf-8');
      } catch (err: any) {
        emitEvent(parentRunId, 'step_failed', {
          stepNumber: step.number, skill: step.skill, iteration,
          reason: 'structured_output_write_failed', error: err?.message,
        });
        return { success: false, error: `Failed to write structured output: ${err?.message}` };
      }
    }

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
        const mt = snapshotMtimes(step.inputs, cwdRoot, outputPathAbs);
        return {
          success: true,
          outputPath,
          outputMtime: mt.outputMtime,
          inputMtimes: mt.inputMtimes,
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
    const mt = snapshotMtimes(step.inputs, cwdRoot, undefined);
    return {
      success: true,
      outputPath: outputPath || undefined,
      inputMtimes: mt.inputMtimes,
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
  cwdRoot: string,
): StepResult {
  const outputPath = step.output
    ? resolveTemplateVars(step.output, templateVars).replace('{{ITER}}', String(iteration || 1))
    : '';
  const outputPathAbs = outputPath
    ? (isAbsolute(outputPath) ? outputPath : join(cwdRoot, outputPath))
    : '';

  if (outputPathAbs && existsSync(outputPathAbs)) {
    let outputMtime: number | undefined;
    try {
      outputMtime = statSync(outputPathAbs).mtimeMs;
    } catch {
      // ignore
    }
    return { success: true, outputPath, outputMtime };
  }

  return {
    success: false,
    outputPath: outputPath || undefined,
    error: `Inline step '${step.skill}' requires manual output at: ${outputPath || '(no output path configured)'}`,
  };
}
