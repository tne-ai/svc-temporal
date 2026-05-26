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
  TRANSIENT_RETRY_POLICY,
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

/**
 * Signal to flip the run into "auto-approve the rest" mode. Any in-flight
 * `condition(() => approvalReceived)` wait resolves immediately, and every
 * subsequent stage review / approval gate is skipped.
 *
 * Use case: user watching a long run decides mid-flight "just go ahead,
 * don't ask me again". Separate from the per-gate `approve` signal so a
 * second click doesn't accidentally upgrade a one-off approval to
 * whole-run auto-approve.
 */
export const autoApproveSignal = defineSignal('autoApprove');

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

  // Separate proxy for sync activities. Bumped to TRANSIENT_RETRY_POLICY
  // (unbounded) — a flaky S3 / network hiccup shouldn't bubble up and
  // kill a multi-hour FSM run. Heartbeat timeout still catches truly
  // dead workers.
  const syncActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: WORKSPACE_SYNC_TIMEOUT,
    heartbeatTimeout: '5m',
    retry: TRANSIENT_RETRY_POLICY,
  });

  // Config activity proxy (short timeout — just file reads). Unbounded
  // retry so a transient FS hiccup during plugin sync doesn't kill the
  // run before it even starts.
  const configActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: '30s',
    retry: TRANSIENT_RETRY_POLICY,
  });

  // Fire-and-forget event emission. Kept at a single attempt on purpose
  // — these are best-effort telemetry; an emit failure shouldn't loop
  // forever or hold up the workflow.
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
  //
  // Wipe first so ghost files left behind by previous workflows on this pod
  // can't shadow S3 state. Without this, svc-temporal workers accumulate
  // outputs across runs and agents read stale artifacts — observed on
  // 2026-04-24 with p-ceo1-manage-strategy picking up yesterday's outputs.
  if (!input.resumeState && input.s3Bucket && input.s3Prefix) {
    try {
      await syncActivities.wipeWorkspace({
        localPath: input.workspacePath,
        scopePath: input.workingDir,
      });
    } catch (err) {
      console.warn('[FsmProcessWorkflow] wipeWorkspace failed (non-fatal):', err);
    }
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
  // Mutable copy of input.autoApprove — the autoApprove signal can flip it
  // true mid-run. `input` is readonly from the workflow's perspective.
  let autoApprove = !!input.autoApprove;

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

  // User hit "skip remaining approvals" — release the current gate (if any)
  // and short-circuit every future one.
  setHandler(autoApproveSignal, () => {
    autoApprove = true;
    approvalReceived = true;
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

      // Stage review: wait for human approval signal. Push the workspace to
      // S3 first so the reviewer (on a different pod in prod) can actually
      // fetch the step's artifacts while the workflow blocks.
      if (config.stageReview && !autoApprove) {
        await syncBeforeGate(syncActivities, input);
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

  if (config.approvalGate && !autoApprove && state.phase === Phase.PREAMBLE) {
    state.phase = Phase.APPROVAL_GATE;
    approvalReceived = false;
    await syncBeforeGate(syncActivities, input);
    await condition(() => approvalReceived || cancelled, '7 days');
    if (cancelled) return { status: 'cancelled', state };
  }

  // ─── GENERATOR ↔ EVALUATOR LOOP ───────────────────────────────────────
  //
  // EVALUATOR_MODE=sequential-only means "run generator once, skip the
  // evaluator iteration loop." We express that here as: force the iteration
  // cap to 1 and suppress the evaluator for-loop. An empty generator +
  // empty evaluator (the doc-typical sequential-only shape) is a pass
  // through to postamble — identical in behavior to the pre-existing
  // "skip generator entirely" special case, but with the critical fix that
  // skills declaring sequential-only *with* a populated Generator table
  // (p-ceo1-manage-strategy et al.) now actually run their generator.

  const sequentialOnly = config.evaluatorMode === EvaluatorMode.SEQUENTIAL_ONLY;
  // Caller-supplied input.maxIterations acts as a ceiling against the
  // skill's own cap — never raises it. Watchdogs pass 1 for one-shot
  // semantics; everything else leaves it undefined.
  const skillCap = sequentialOnly ? 1 : config.maxIterations;
  const effectiveMaxIterations = input.maxIterations != null
    ? Math.min(skillCap, input.maxIterations)
    : skillCap;

  if (state.phase === Phase.PREAMBLE || state.phase === Phase.APPROVAL_GATE) {
    state.phase = Phase.GENERATOR;
    state.iteration = 1;
  }

  while (state.iteration <= effectiveMaxIterations && !cancelled) {
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

        if (config.stageReview && !autoApprove) {
          await syncBeforeGate(syncActivities, input);
          state.steps[stepKey]!.status = StepStatus.AWAITING_REVIEW;
          approvalReceived = false;
          await condition(() => approvalReceived || cancelled, '7 days');
          if (cancelled) return { status: 'cancelled', state };
          state.steps[stepKey]!.humanNotes = approvalNotes;
          state.steps[stepKey]!.status = StepStatus.COMPLETE;
        }
      }
    }

    // Evaluator phase. Skipped entirely under sequential-only — the whole
    // point of that mode is "no evaluator loop."
    state.phase = Phase.EVALUATOR;
    let allPassed = true;
    const keyIssues: string[] = [];
    let stoppingEvaluator = '';

    if (!sequentialOnly) {
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

  if (state.iteration > effectiveMaxIterations) {
    state.earlyExit = true;
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

/**
 * Push the workspace to S3 before a human approval gate. In multi-pod prod
 * orion-backend can't see files on the worker's local disk, so without this
 * the reviewer's UI gets a stale (or empty) view of the step's artifacts.
 *
 * Best-effort — a failed push shouldn't block the gate. The workflow's
 * existing final-push still runs at completion.
 */
async function syncBeforeGate(
  syncActivities: { pushWorkspaceToS3: (p: { bucket: string; prefix: string; localPath: string; scopePath?: string }) => Promise<unknown> },
  input: FsmProcessInput,
): Promise<void> {
  if (!input.s3Bucket || !input.s3Prefix) return;
  try {
    await syncActivities.pushWorkspaceToS3({
      bucket: input.s3Bucket,
      prefix: input.s3Prefix,
      localPath: input.workspacePath,
      scopePath: input.workingDir,
    });
  } catch (err) {
    console.warn('[FsmProcessWorkflow] pre-gate pushWorkspaceToS3 failed (non-fatal):', err);
  }
}

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
  // Per-user delegate (worker) model override: when the user has configured
  // a delegate model in Horizon's Settings → Delegate Model, that overrides
  // the SKILL.md per-step model. Falls back to step.model when the user
  // hasn't opted in. This is the entire point of delegation — "all my
  // workers run on X" without editing each skill.
  const effectiveStep: Step = input.delegateModel
    ? { ...step, model: input.delegateModel }
    : step;
  return {
    step: effectiveStep,
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
    config,
    state,
    currentStepKey: `${phase}.${step.number}`,
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
 * Dependency reference from a step's `dependsOn` list.
 *   • `num`  — bare number (e.g. `"4"`). Resolves against this phase first,
 *              then any other phase with a matching step number in state.
 *   • `qual` — phase-qualified (e.g. `"generator.4"`). Resolves directly
 *              against `state.steps["generator.4"]`.
 *   • `all`  — wildcard meaning "every other step in this phase".
 */
type ParsedDep =
  | { kind: 'num'; number: string }
  | { kind: 'qual'; phase: string; number: string }
  | { kind: 'all' };

function parseDep(raw: string): ParsedDep | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === 'all') return { kind: 'all' };
  const parts = trimmed.split('.').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length >= 2) return { kind: 'qual', phase: parts[0], number: parts.slice(1).join('.') };
  return { kind: 'num', number: parts[0] };
}

function formatDep(dep: ParsedDep): string {
  if (dep.kind === 'all') return 'all';
  if (dep.kind === 'qual') return `${dep.phase}.${dep.number}`;
  return dep.number;
}

/**
 * Run a phase's steps in parallel with DAG-ordered waves and cancel-siblings
 * semantics on failure.
 *
 * Semantics:
 *   • Build a dependency map from `step.dependsOn` — supports bare numbers
 *     (`"3"`), phase-qualified keys (`"generator.4"`), the `"all"` wildcard,
 *     and mixed forms.
 *   • Cross-phase deps are resolved against `state.steps` globally: a
 *     postamble step with `dependsOn: ["generator.4"]` is satisfied iff
 *     `state.steps["generator.4"]` is COMPLETE.
 *   • Each wave runs every step whose deps are all satisfied, wrapped
 *     in a single `CancellationScope`. If any step fails mid-wave the scope
 *     is cancelled, in-flight siblings receive cancellation errors, and they
 *     are recorded as `cancelled` (not `failed`) so the UI can render them
 *     distinctly.
 *   • After each wave, failures and cancellations cascade to any step
 *     transitively blocked on them — those are also marked cancelled.
 *   • If the loop reaches a point where work remains but nothing is ready,
 *     throws `PhaseDeadlockError` with the unsatisfied deps listed. This
 *     surfaces SOP misconfigs (e.g. postamble depending on a generator step
 *     that was skipped under `EVALUATOR_MODE=sequential-only`) as explicit
 *     workflow failures instead of silent "completed with nothing done".
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

  const completed = new Set<string>();
  const failed = new Set<string>();
  const cancelledSteps = new Set<string>();
  let waveIdx = 0;

  const depMap = new Map<string, ParsedDep[]>();
  for (const step of steps) {
    const deps: ParsedDep[] = [];
    for (const depKey of step.dependsOn) {
      const parsed = parseDep(depKey);
      if (parsed) deps.push(parsed);
    }
    depMap.set(step.number, deps);
  }

  // Pre-seed already-complete steps (resume case)
  for (const step of steps) {
    const ss = state.steps[`${phaseKey}.${step.number}`];
    if (ss?.status === StepStatus.COMPLETE) completed.add(step.number);
  }

  // Dep resolution — unified over local (this-phase) and global (state.steps).
  // `selfNumber` is excluded from `all` so a step can depend on "all" without
  // waiting on itself.
  const isSatisfied = (dep: ParsedDep, selfNumber: string): boolean => {
    if (dep.kind === 'all') {
      return steps.every(s => s.number === selfNumber || completed.has(s.number));
    }
    if (dep.kind === 'qual') {
      return state.steps[`${dep.phase}.${dep.number}`]?.status === StepStatus.COMPLETE;
    }
    if (completed.has(dep.number)) return true;
    // Cross-phase fallback: any other phase with this step number COMPLETE.
    for (const [key, st] of Object.entries(state.steps)) {
      if (st?.status === StepStatus.COMPLETE && key.endsWith(`.${dep.number}`)) return true;
    }
    return false;
  };

  const isBlockedByFailure = (dep: ParsedDep, selfNumber: string): boolean => {
    if (dep.kind === 'all') {
      return steps.some(s =>
        s.number !== selfNumber && (failed.has(s.number) || cancelledSteps.has(s.number)),
      );
    }
    if (dep.kind === 'qual') {
      return state.steps[`${dep.phase}.${dep.number}`]?.status === StepStatus.FAILED;
    }
    if (failed.has(dep.number) || cancelledSteps.has(dep.number)) return true;
    for (const [key, st] of Object.entries(state.steps)) {
      if (st?.status === StepStatus.FAILED && key.endsWith(`.${dep.number}`)) return true;
    }
    return false;
  };

  while (completed.size + failed.size + cancelledSteps.size < steps.length) {
    if (isCancelled()) return { failed: failed.size > 0 };

    const ready = steps.filter(s => {
      if (completed.has(s.number) || failed.has(s.number) || cancelledSteps.has(s.number)) return false;
      const deps = depMap.get(s.number) || [];
      if (deps.some(d => isBlockedByFailure(d, s.number))) return false;
      return deps.every(d => isSatisfied(d, s.number));
    });

    if (ready.length === 0) {
      // Deadlock: work remains but nothing is runnable. Surface the misconfig
      // instead of silently completing with pending steps.
      const blocked: string[] = [];
      for (const step of steps) {
        if (completed.has(step.number) || failed.has(step.number) || cancelledSteps.has(step.number)) continue;
        const unresolved = (depMap.get(step.number) || [])
          .filter(d => !isSatisfied(d, step.number))
          .map(formatDep);
        blocked.push(`${phaseKey}.${step.number} waiting on [${unresolved.join(', ') || '—'}]`);
      }
      throw new Error(
        `runPhaseParallel[${phaseKey}]: deadlock — ${blocked.length} step(s) have unsatisfied dependencies:\n  ` +
        blocked.join('\n  ') +
        `\nThis usually means the SOP declares cross-phase dependencies on steps that never ran ` +
        `(e.g. a postamble step depending on a generator step when EVALUATOR_MODE=sequential-only skips generator).`,
      );
    }

    waveIdx++;
    const isFanOut = ready.length > 1;
    const waveResults = new Map<string, { step: Step; result: StepResult | null; wasCancelled: boolean }>();

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
        const deps = depMap.get(step.number) || [];
        if (deps.some(d => isBlockedByFailure(d, step.number))) {
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
