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
} from '@temporalio/workflow';

import type {
  FsmProcessInput,
  FsmProcessResult,
  FsmWorkflowState,
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

  // Initialize or resume state
  const state: FsmWorkflowState = input.resumeState || initializeState(input);

  // ── Pull workspace from S3 (skip on resume — already pulled) ──────────
  if (!input.resumeState && input.s3Bucket && input.s3Prefix) {
    try {
      await syncActivities.pullWorkspaceFromS3({
        bucket: input.s3Bucket,
        prefix: input.s3Prefix,
        localPath: input.workspacePath,
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

    for (const step of input.config.preamble) {
      if (cancelled) return { status: 'cancelled', state };

      const stepKey = `preamble.${step.number}`;
      const stepState = state.steps[stepKey];

      // Skip already completed steps (resume case)
      if (stepState?.status === StepStatus.COMPLETE) continue;

      const result = await executeStep(buildStepParams(step, 0, input, state));
      updateStepState(state, stepKey, result);

      if (!result.success) {
        return { status: 'failed', state };
      }

      // Stage review: wait for human approval signal
      if (input.config.stageReview && !input.autoApprove) {
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

  if (input.config.approvalGate && state.phase === Phase.PREAMBLE) {
    state.phase = Phase.APPROVAL_GATE;
    approvalReceived = false;
    await condition(() => approvalReceived || cancelled, '7 days');
    if (cancelled) return { status: 'cancelled', state };
  }

  // ─── GENERATOR ↔ EVALUATOR LOOP ───────────────────────────────────────

  if (input.config.evaluatorMode !== EvaluatorMode.SEQUENTIAL_ONLY) {
    if (state.phase === Phase.PREAMBLE || state.phase === Phase.APPROVAL_GATE) {
      state.phase = Phase.GENERATOR;
      state.iteration = 1;
    }

    while (state.iteration <= input.config.maxIterations && !cancelled) {
      // Generator phase
      state.phase = Phase.GENERATOR;
      const feedback = collectFeedback(state);

      for (const step of input.config.generator) {
        if (cancelled) return { status: 'cancelled', state };

        const stepKey = `generator.${step.number}`;

        // Reset steps on iteration > 1
        if (state.iteration > 1) {
          resetStepState(state, stepKey);
        }

        const result = await executeStep(
          buildStepParams(step, state.iteration, input, state, feedback)
        );
        updateStepState(state, stepKey, result);

        if (!result.success) {
          return { status: 'failed', state };
        }

        if (input.config.stageReview && !input.autoApprove) {
          state.steps[stepKey]!.status = StepStatus.AWAITING_REVIEW;
          approvalReceived = false;
          await condition(() => approvalReceived || cancelled, '7 days');
          if (cancelled) return { status: 'cancelled', state };
          state.steps[stepKey]!.humanNotes = approvalNotes;
          state.steps[stepKey]!.status = StepStatus.COMPLETE;
        }
      }

      // Evaluator phase
      state.phase = Phase.EVALUATOR;
      let allPassed = true;
      const keyIssues: string[] = [];
      let stoppingEvaluator = '';

      for (const step of input.config.evaluator) {
        if (cancelled) return { status: 'cancelled', state };

        const stepKey = `evaluator.${step.number}`;
        resetStepState(state, stepKey);

        const result = await executeStep(
          buildStepParams(step, state.iteration, input, state)
        );
        updateStepState(state, stepKey, result);

        if (!result.success) {
          allPassed = false;
          stoppingEvaluator = step.skill;
          keyIssues.push(result.feedback || result.error || 'Evaluator failed');

          if (input.config.evaluatorMode === EvaluatorMode.FAIL_FAST) break;
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
          resumeState: state,
        });
      }
    }

    if (state.iteration > input.config.maxIterations) {
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

    if (input.config.postamble.length > 0) {
      const hasDeps = input.config.postamble.some(s => s.dependsOn.length > 0);

      if (hasDeps) {
        await runPostambleParallel(input, state, executeStep);
      } else {
        // Sequential postamble
        for (const step of input.config.postamble) {
          if (cancelled) return { status: 'cancelled', state };

          const stepKey = `postamble.${step.number}`;
          const stepState = state.steps[stepKey];
          if (stepState?.status === StepStatus.COMPLETE) continue;

          const result = await executeStep(buildStepParams(step, 0, input, state));
          updateStepState(state, stepKey, result);

          if (!result.success) {
            return { status: 'failed', state };
          }

          if (input.config.stageReview && !input.autoApprove) {
            state.steps[stepKey]!.status = StepStatus.AWAITING_REVIEW;
            approvalReceived = false;
            await condition(() => approvalReceived || cancelled, '7 days');
            if (cancelled) return { status: 'cancelled', state };
            state.steps[stepKey]!.humanNotes = approvalNotes;
            state.steps[stepKey]!.status = StepStatus.COMPLETE;
          }
        }
      }
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

function initializeState(input: FsmProcessInput): FsmWorkflowState {
  const steps: Record<string, StepState> = {};

  for (const [phaseName, phaseSteps] of Object.entries({
    preamble: input.config.preamble,
    generator: input.config.generator,
    evaluator: input.config.evaluator,
    postamble: input.config.postamble,
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
  state: FsmWorkflowState,
  feedback?: string,
): StepExecutionParams {
  return {
    step,
    iteration,
    templateVars: input.templateVars,
    feedback,
    humanNotes: state.steps[`${stepPhase(step, input)}.${step.number}`]?.humanNotes,
    workspacePath: input.workspacePath,
    agentBackend: input.agentBackend,
  };
}

function stepPhase(step: Step, input: FsmProcessInput): string {
  if (input.config.preamble.includes(step)) return 'preamble';
  if (input.config.generator.includes(step)) return 'generator';
  if (input.config.evaluator.includes(step)) return 'evaluator';
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
 * Run postamble steps in parallel with dependency resolution.
 */
async function runPostambleParallel(
  input: FsmProcessInput,
  state: FsmWorkflowState,
  executeStep: (params: StepExecutionParams) => Promise<StepResult>,
): Promise<void> {
  const steps = input.config.postamble;
  const completed = new Set<number>();
  const failed = new Set<number>();

  // Build dependency map: step.number → set of step numbers it depends on
  const depMap = new Map<number, Set<number>>();
  for (const step of steps) {
    const deps = new Set<number>();
    for (const depKey of step.dependsOn) {
      const parts = depKey.split('.');
      if (parts.length === 2 && parts[0] === 'postamble') {
        const num = parseInt(parts[1], 10);
        if (!isNaN(num)) deps.add(num);
      }
    }
    depMap.set(step.number, deps);
  }

  // Pre-seed already-complete steps
  for (const step of steps) {
    const ss = state.steps[`postamble.${step.number}`];
    if (ss?.status === StepStatus.COMPLETE) {
      completed.add(step.number);
    }
  }

  while (completed.size + failed.size < steps.length) {
    // Find ready steps
    const ready = steps.filter(s => {
      if (completed.has(s.number) || failed.has(s.number)) return false;
      const deps = depMap.get(s.number) || new Set();
      return [...deps].every(d => completed.has(d)) && ![...deps].some(d => failed.has(d));
    });

    if (ready.length === 0) break;

    // Fan out ready steps in parallel
    const results = await Promise.all(
      ready.map(async (step) => {
        const result = await executeStep(buildStepParams(step, 0, input, state));
        return { step, result };
      })
    );

    for (const { step, result } of results) {
      updateStepState(state, `postamble.${step.number}`, result);
      if (result.success) {
        completed.add(step.number);
      } else {
        failed.add(step.number);
      }
    }

    // Cascade failures to blocked dependents
    for (const step of steps) {
      if (!completed.has(step.number) && !failed.has(step.number)) {
        const deps = depMap.get(step.number) || new Set();
        if ([...deps].some(d => failed.has(d))) {
          failed.add(step.number);
        }
      }
    }
  }
}
