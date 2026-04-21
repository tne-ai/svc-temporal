/**
 * FsmProcessWorkflow — the main FSM orchestration workflow.
 *
 * Replaces the Python FSMEngine.run() main loop with native Temporal
 * workflow execution. Each phase (preamble, generator, evaluator, postamble,
 * finalization) is implemented as workflow control flow, with individual
 * step executions dispatched as activities.
 *
 * Key Temporal features used:
 * - Signals for human-in-the-loop approval gates and stage reviews
 * - Queries for real-time status polling from the Horizon frontend
 * - continueAsNew to bound event history on long generator/evaluator loops
 * - Promise.all for parallel postamble execution with dependency resolution
 */

import {
  condition,
  continueAsNew,
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  sleep,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';

import type {
  FsmProcessInput,
  FsmProcessResult,
  FsmWorkflowState,
  ProcessConfig,
  StepState,
  Step,
  IterationRecord,
  StepResult,
  StepExecutionParams,
  ApprovalSignalPayload,
} from '../shared/types.js';
import {
  Phase,
  StepStatus,
  EvaluatorMode,
} from '../shared/types.js';
import {
  STEP_ACTIVITY_TIMEOUT,
  STEP_HEARTBEAT_TIMEOUT,
  STEP_RETRY_POLICY,
  WORKSPACE_SYNC_TIMEOUT,
  CONTINUE_AS_NEW_INTERVAL,
} from '../shared/constants.js';

// Import activity types only (actual functions run in the activity worker)
import type * as activities from '../activities/index.js';

// ─── Signals ────────────────────────────────────────────────────────────────

/** Signal to approve a pending review gate */
export const approveSignal = defineSignal<[ApprovalSignalPayload]>('approve');

/** Signal to reject/revise a pending review gate */
export const rejectSignal = defineSignal<[ApprovalSignalPayload]>('reject');

/** Signal to cancel the workflow gracefully */
export const cancelSignal = defineSignal('cancel');

// ─── Queries ────────────────────────────────────────────────────────────────

/** Query the current workflow state (phase, steps, iterations) */
export const getStateQuery = defineQuery<FsmWorkflowState>('getState');

/** Query the current phase */
export const getPhaseQuery = defineQuery<string>('getPhase');

// ─── Workflow Implementation ────────────────────────────────────────────────

export async function FsmProcessWorkflow(input: FsmProcessInput): Promise<FsmProcessResult> {
  // Proxy activities with appropriate timeouts
  const { executeStep } = proxyActivities<typeof activities>({
    startToCloseTimeout: STEP_ACTIVITY_TIMEOUT,
    heartbeatTimeout: STEP_HEARTBEAT_TIMEOUT,
    retry: STEP_RETRY_POLICY,
  });

  // Separate proxy for sync activities with shorter timeout
  const syncActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: WORKSPACE_SYNC_TIMEOUT,
    heartbeatTimeout: '60s',
    retry: { maximumAttempts: 2, initialInterval: '5s', backoffCoefficient: 2 },
  });

  // Config activity proxy (short timeout — just file reads)
  const configActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: '30s',
    retry: { maximumAttempts: 2, initialInterval: '2s', backoffCoefficient: 2 },
  });

  // Fire-and-forget event emission proxy. Used by the workflow itself to emit
  // cancellation events (the activity-side executeStep handles its own events).
  const eventActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: '15s',
    retry: { maximumAttempts: 1 },
  });

  // ── Resolve config: either provided directly or parsed from skillName ──
  let config: import('../shared/types.js').ProcessConfig;
  if (input.config) {
    config = input.config;
  } else if (input.skillName) {
    const parsed = await configActivities.parseConfig({
      skillName: input.skillName,
      workspacePath: input.workspacePath,
      variables: input.templateVars,
    });
    config = parsed.config;
  } else {
    return {
      status: 'failed',
      state: { phase: Phase.INIT, iteration: 0, steps: {}, iterations: [], earlyExit: true },
    };
  }

  // Initialize or resume state
  const state: FsmWorkflowState = input.resumeState || initializeState(config);

  // ── Pull workspace from S3 (skip on resume — already pulled) ──────────
  // Scoped by `workingDir` so a run in "<root>/test1" only pulls S3
  // `{userId}/test1/*` and never spills sibling subdirs into cwd.
  if (!input.resumeState && input.s3Bucket && input.s3Prefix) {
    try {
      await syncActivities.pullWorkspaceFromS3({
        bucket: input.s3Bucket,
        prefix: input.s3Prefix,
        localPath: input.workspacePath,
        scopePath: input.workingDir,
      });
    } catch {
      // Non-fatal — may be first run with empty workspace
    }
  }

  // Signal state
  let approvalReceived = false;
  let approvalNotes = '';
  let cancelled = false;

  // Register signal handlers
  setHandler(approveSignal, (payload) => {
    approvalReceived = true;
    approvalNotes = payload.notes || '';
  });

  setHandler(rejectSignal, (payload) => {
    approvalReceived = true;
    approvalNotes = payload.notes || '';
  });

  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  // Register query handlers
  setHandler(getStateQuery, () => state);
  setHandler(getPhaseQuery, () => state.phase);

  // ─── PREAMBLE ──────────────────────────────────────────────────────────

  if (state.phase === Phase.INIT || state.phase === Phase.PREAMBLE) {
    state.phase = Phase.PREAMBLE;

    for (const step of config.preamble) {
      if (cancelled) return { status: 'cancelled', state };

      const stepKey = `preamble.${step.number}`;
      const stepState = state.steps[stepKey];

      // Skip already completed steps (resume case)
      if (stepState?.status === StepStatus.COMPLETE) continue;

      const result = await executeStep(buildStepParams(step, 0, input, config, state));
      updateStepState(state, stepKey, result);

      if (!result.success) {
        return { status: 'failed', state };
      }

      // Stage review: wait for human approval signal
      if (config.stageReview && !input.autoApprove) {
        state.steps[stepKey]!.status = StepStatus.AWAITING_REVIEW;
        approvalReceived = false;
        await condition(() => approvalReceived || cancelled, '7 days');
        if (cancelled) return { status: 'cancelled', state };
        state.steps[stepKey]!.humanNotes = approvalNotes;
        state.steps[stepKey]!.status = StepStatus.COMPLETE;
      }
    }
  }

  // ─── APPROVAL GATE ─────────────────────────────────────────────────────

  if (config.approvalGate && state.phase === Phase.PREAMBLE) {
    state.phase = Phase.APPROVAL_GATE;
    approvalReceived = false;
    await condition(() => approvalReceived || cancelled, '7 days');
    if (cancelled) return { status: 'cancelled', state };
  }

  // ─── GENERATOR ↔ EVALUATOR LOOP ───────────────────────────────────────

  if (config.evaluatorMode !== EvaluatorMode.SEQUENTIAL_ONLY) {
    if (state.phase === Phase.PREAMBLE || state.phase === Phase.APPROVAL_GATE) {
      state.phase = Phase.GENERATOR;
      state.iteration = 1;
    }

    while (state.iteration <= config.maxIterations && !cancelled) {
      // Generator phase
      state.phase = Phase.GENERATOR;
      const feedback = collectFeedback(state);

      // Reset generator step state on iterations > 1 before running
      if (state.iteration > 1) {
        for (const step of config.generator) {
          resetStepState(state, `generator.${step.number}`);
        }
      }

      // Parallel generator (opt-in via PARALLEL_GENERATOR=true).
      // Stage review + parallel fan-out don't compose cleanly (humans can't
      // realistically gate between fanned-out siblings), so parallel mode
      // bypasses per-step stage review inside the generator wave.
      if (config.parallelGenerator) {
        const outcome = await runPhaseParallel(
          'generator', config.generator, input, config, state, executeStep,
          state.iteration, feedback, () => cancelled,
          (data) => eventActivities.emitFsmEventActivity({ runId: input.runId, type: 'step_cancelled', data }),
        );
        if (cancelled) return { status: 'cancelled', state };
        if (outcome.failed) {
          return { status: 'failed', state };
        }
      } else {
        for (const step of config.generator) {
          if (cancelled) return { status: 'cancelled', state };

          const stepKey = `generator.${step.number}`;
          const result = await executeStep(
            buildStepParams(step, state.iteration, input, config, state, feedback)
          );
          updateStepState(state, stepKey, result);

          if (!result.success) {
            return { status: 'failed', state };
          }

          if (config.stageReview && !input.autoApprove) {
            state.steps[stepKey]!.status = StepStatus.AWAITING_REVIEW;
            approvalReceived = false;
            await condition(() => approvalReceived || cancelled, '7 days');
            if (cancelled) return { status: 'cancelled', state };
            state.steps[stepKey]!.humanNotes = approvalNotes;
            state.steps[stepKey]!.status = StepStatus.COMPLETE;
          }
        }
      }

      // Evaluator phase
      state.phase = Phase.EVALUATOR;
      let allPassed = true;
      const keyIssues: string[] = [];
      let stoppingEvaluator = '';

      for (const step of config.evaluator) {
        if (cancelled) return { status: 'cancelled', state };

        const stepKey = `evaluator.${step.number}`;
        resetStepState(state, stepKey);

        const result = await executeStep(
          buildStepParams(step, state.iteration, input, config, state)
        );
        updateStepState(state, stepKey, result);

        if (!result.success) {
          allPassed = false;
          stoppingEvaluator = step.skill;
          keyIssues.push(result.feedback || result.error || 'Evaluator failed');

          if (config.evaluatorMode === EvaluatorMode.FAIL_FAST) break;
        }
      }

      // Record iteration result
      const record: IterationRecord = {
        iteration: state.iteration,
        result: allPassed ? 'PASS' : 'FAIL',
        stoppingEvaluator,
        keyIssues: keyIssues.join('; '),
        timestamp: new Date().toISOString(),
      };
      state.iterations.push(record);

      if (allPassed) break;

      state.iteration++;

      // continueAsNew to prevent history growth on long loops
      if (state.iteration % CONTINUE_AS_NEW_INTERVAL === 0) {
        state.phase = Phase.GENERATOR;
        await continueAsNew<typeof FsmProcessWorkflow>({
          ...input,
          config,
          resumeState: state,
        });
      }
    }

    if (state.iteration > config.maxIterations) {
      state.earlyExit = true;
    }
  } else {
    // Sequential-only mode: skip generator/evaluator, go straight to postamble
    if (state.phase !== Phase.POSTAMBLE && state.phase !== Phase.FINALIZATION && state.phase !== Phase.COMPLETE) {
      state.phase = Phase.POSTAMBLE;
    }
  }

  // ─── POSTAMBLE (parallel with dependency graph) ────────────────────────

  if (state.phase !== Phase.FINALIZATION && state.phase !== Phase.COMPLETE) {
    state.phase = Phase.POSTAMBLE;

    if (config.postamble.length > 0) {
      // Always route postamble through the parallel runner. When every step
      // has empty `dependsOn`, wave 1 fans them all out; when deps form a
      // DAG, waves respect it. Sequential is the degenerate case.
      await runPhaseParallel(
        'postamble', config.postamble, input, config, state, executeStep,
        0, undefined, () => cancelled,
        (data) => eventActivities.emitFsmEventActivity({ runId: input.runId, type: 'step_cancelled', data }),
      );
      if (cancelled) return { status: 'cancelled', state };
    }
  }

  // ─── FINALIZATION ──────────────────────────────────────────────────────

  state.phase = Phase.FINALIZATION;

  // Finalization is a pure file-copy operation — handled as a lightweight activity
  // For now, finalization entries are simple enough to skip (the output files
  // are already in place from the generator). Full finalization (versioned → final
  // file copy) can be added as an activity.

  // ─── PUSH WORKSPACE TO S3 ───────────────────────────────────────────

  if (input.s3Bucket && input.s3Prefix) {
    try {
      await syncActivities.pushWorkspaceToS3({
        bucket: input.s3Bucket,
        prefix: input.s3Prefix,
        localPath: input.workspacePath,
      });
    } catch {
      // Non-fatal: S3 sync failure doesn't fail the workflow
    }
  }

  // ─── COMPLETE ──────────────────────────────────────────────────────────

  state.phase = Phase.COMPLETE;
  return { status: 'completed', state };
}

// ─── Helper Functions ───────────────────────────────────────────────────────

function initializeState(config: ProcessConfig): FsmWorkflowState {
  const steps: Record<string, StepState> = {};

  for (const [phaseName, phaseSteps] of Object.entries({
    preamble: config.preamble,
    generator: config.generator,
    evaluator: config.evaluator,
    postamble: config.postamble,
  })) {
    for (const step of phaseSteps) {
      steps[`${phaseName}.${step.number}`] = {
        status: StepStatus.PENDING,
        retries: 0,
      };
    }
  }

  return {
    phase: Phase.INIT,
    iteration: 0,
    steps,
    iterations: [],
    earlyExit: false,
  };
}

function buildStepParams(
  step: Step,
  iteration: number,
  input: FsmProcessInput,
  config: ProcessConfig,
  state: FsmWorkflowState,
  feedback?: string,
  overridePhase?: 'preamble' | 'generator' | 'evaluator' | 'postamble',
  parallel?: boolean,
  waveIdx?: number,
): StepExecutionParams {
  const phase = overridePhase || (stepPhase(step, config) as 'preamble' | 'generator' | 'evaluator' | 'postamble');
  return {
    step,
    iteration,
    templateVars: input.templateVars,
    feedback,
    humanNotes: state.steps[`${phase}.${step.number}`]?.humanNotes,
    workspacePath: input.workspacePath,
    workingDir: input.workingDir,
    agentBackend: input.agentBackend,
    parentRunId: input.runId,
    userId: input.userId,
    s3Bucket: input.s3Bucket,
    s3Prefix: input.s3Prefix,
    phase,
    parallel,
    waveIdx,
  };
}

function stepPhase(step: Step, config: ProcessConfig): string {
  if (config.preamble.includes(step)) return 'preamble';
  if (config.generator.includes(step)) return 'generator';
  if (config.evaluator.includes(step)) return 'evaluator';
  return 'postamble';
}

function updateStepState(state: FsmWorkflowState, stepKey: string, result: StepResult): void {
  state.steps[stepKey] = {
    ...state.steps[stepKey],
    status: result.success ? StepStatus.COMPLETE : StepStatus.FAILED,
    outputPath: result.outputPath,
    feedback: result.feedback,
    error: result.error,
    gateResults: result.gateResults,
    completedAt: new Date().toISOString(),
    retries: state.steps[stepKey]?.retries || 0,
  };
}

function resetStepState(state: FsmWorkflowState, stepKey: string): void {
  state.steps[stepKey] = {
    status: StepStatus.PENDING,
    retries: 0,
  };
}

function collectFeedback(state: FsmWorkflowState): string {
  if (state.iteration <= 1) return '';

  const parts: string[] = [];
  const prevIter = state.iteration - 1;

  for (const record of state.iterations) {
    if (record.iteration === prevIter && record.keyIssues) {
      parts.push(`Iteration ${prevIter} feedback: ${record.keyIssues}`);
      break;
    }
  }

  // Include evaluator step feedback
  for (const [key, stepState] of Object.entries(state.steps)) {
    if (key.startsWith('evaluator.') && stepState.feedback) {
      parts.push(stepState.feedback);
    }
  }

  return parts.join('\n\n');
}

/**
 * Run a phase's steps in parallel with DAG-ordered waves and cancel-siblings
 * semantics on failure.
 *
 * Semantics:
 *   • Build a dependency map from `step.dependsOn` — supports bare numbers
 *     (`"3"`), phase-qualified keys (`"postamble.3"`), and mixed forms.
 *   • Each wave runs every step whose deps are all in `completed`, wrapped
 *     in a single `CancellationScope`. If any step fails mid-wave the scope
 *     is cancelled, in-flight siblings receive cancellation errors, and they
 *     are recorded as `cancelled` (not `failed`) so the UI can render them
 *     distinctly.
 *   • After each wave, failures and cancellations cascade to any step
 *     transitively blocked on them — those are also marked cancelled.
 *   • Returns `failed=true` if any non-cascade failure occurred (lets the
 *     caller decide whether to abort the workflow or continue).
 */
async function runPhaseParallel(
  phaseKey: 'preamble' | 'generator' | 'evaluator' | 'postamble',
  steps: Step[],
  input: FsmProcessInput,
  config: ProcessConfig,
  state: FsmWorkflowState,
  executeStep: (params: StepExecutionParams) => Promise<StepResult>,
  iteration: number,
  feedback: string | undefined,
  isCancelled: () => boolean,
  emitCancelEvent: (data: Record<string, any>) => Promise<void>,
): Promise<{ failed: boolean }> {
  if (steps.length === 0) return { failed: false };

  const completed = new Set<number>();
  const failed = new Set<number>();
  const cancelledSteps = new Set<number>();
  let waveIdx = 0;

  const depMap = new Map<number, Set<number>>();
  for (const step of steps) {
    const deps = new Set<number>();
    for (const depKey of step.dependsOn) {
      const parts = depKey.split('.');
      const raw = parts.length === 2 ? parts[1] : parts[0];
      const num = parseInt(raw, 10);
      if (!isNaN(num)) deps.add(num);
    }
    depMap.set(step.number, deps);
  }

  // Pre-seed already-complete steps (resume case)
  for (const step of steps) {
    const ss = state.steps[`${phaseKey}.${step.number}`];
    if (ss?.status === StepStatus.COMPLETE) completed.add(step.number);
  }

  while (completed.size + failed.size + cancelledSteps.size < steps.length) {
    if (isCancelled()) return { failed: failed.size > 0 };

    const ready = steps.filter(s => {
      if (completed.has(s.number) || failed.has(s.number) || cancelledSteps.has(s.number)) return false;
      const deps = depMap.get(s.number) || new Set();
      if ([...deps].some(d => failed.has(d) || cancelledSteps.has(d))) return false;
      return [...deps].every(d => completed.has(d));
    });

    if (ready.length === 0) break;

    waveIdx++;
    const isFanOut = ready.length > 1;
    const waveResults = new Map<number, { step: Step; result: StepResult | null; wasCancelled: boolean }>();

    try {
      await CancellationScope.cancellable(async () => {
        await Promise.all(
          ready.map(async (step) => {
            try {
              const result = await executeStep(
                buildStepParams(step, iteration, input, config, state, feedback, phaseKey, isFanOut, waveIdx)
              );
              waveResults.set(step.number, { step, result, wasCancelled: false });
              if (!result.success) {
                // Cancel in-flight siblings. They'll throw CancelledFailure at
                // their next suspension point and be caught below as cancelled.
                CancellationScope.current().cancel();
              }
            } catch (err) {
              if (isCancellation(err)) {
                waveResults.set(step.number, { step, result: null, wasCancelled: true });
              } else {
                throw err;
              }
            }
          }),
        );
      });
    } catch (err) {
      if (!isCancellation(err)) throw err;
    }

    // Commit wave outcomes to state + notify UI for cancelled siblings.
    for (const { step, result, wasCancelled } of waveResults.values()) {
      const stepKey = `${phaseKey}.${step.number}`;
      if (wasCancelled) {
        cancelledSteps.add(step.number);
        state.steps[stepKey] = {
          ...state.steps[stepKey],
          status: StepStatus.FAILED,
          error: 'cancelled: sibling step failed',
          completedAt: new Date().toISOString(),
          retries: state.steps[stepKey]?.retries || 0,
        };
        await emitCancelEvent({
          stepNumber: step.number, skill: step.skill, iteration, phase: phaseKey,
          reason: 'sibling_failed',
        });
      } else if (result) {
        updateStepState(state, stepKey, result);
        if (result.success) completed.add(step.number);
        else failed.add(step.number);
      }
    }

    // Cascade failures/cancellations to transitively blocked dependents.
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) {
        if (completed.has(step.number) || failed.has(step.number) || cancelledSteps.has(step.number)) continue;
        const deps = depMap.get(step.number) || new Set();
        if ([...deps].some(d => failed.has(d) || cancelledSteps.has(d))) {
          cancelledSteps.add(step.number);
          changed = true;
          const stepKey = `${phaseKey}.${step.number}`;
          state.steps[stepKey] = {
            ...state.steps[stepKey],
            status: StepStatus.FAILED,
            error: 'cancelled: dependency failed',
            completedAt: new Date().toISOString(),
            retries: 0,
          };
          await emitCancelEvent({
            stepNumber: step.number, skill: step.skill, iteration, phase: phaseKey,
            reason: 'dependency_failed',
          });
        }
      }
    }
  }

  return { failed: failed.size > 0 };
}
