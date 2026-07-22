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
  workflowInfo,
  executeChild,
  ChildWorkflowCancellationType,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';

import type {
  FsmProcessInput,
  FsmProcessResult,
  FsmWorkflowState,
  FreshnessCheckParams,
  ProcessConfig,
  StepState,
  Step,
  IterationRecord,
  StepResult,
  StepExecutionParams,
  ApprovalSignalPayload,
} from '../shared/types.js';
import { handleBackprop, propagateForward } from './propagation.js';
import {
  Phase,
  StepStatus,
  EvaluatorMode,
} from '../shared/types.js';
import {
  type ParsedDep,
  parseDep,
  formatDep,
  isDepSatisfied,
  isDepBlockedByFailure,
} from './depResolution.js';
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
// Payload is optional for backward compat — callers that pre-date the
// bidirectional toggle invoke this signal with no arguments, and the
// handler treats the empty payload as "enable" (the only thing the
// original signal could do).
export const autoApproveSignal = defineSignal<[{ enabled?: boolean }?]>('autoApprove');

// ─── Queries ────────────────────────────────────────────────────────────────

/** Query the current workflow state (phase, steps, iterations) */
export const getStateQuery = defineQuery<FsmWorkflowState>('getState');

/** Query the current phase */
export const getPhaseQuery = defineQuery<string>('getPhase');

/** Query the current auto-approve flag so the FE can render the toggle's
 *  initial state without persisting it in the orion DB. */
export const getAutoApproveQuery = defineQuery<boolean>('getAutoApprove');

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
  // run before it even starts — EXCEPT for `SkillConfigError` (a malformed /
  // missing skill definition), which is deterministic and would otherwise loop
  // forever. parseConfig throws those as non-retryable ApplicationFailures;
  // this type list is defense-in-depth so a bad skill fails fast either way.
  const configActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: '30s',
    retry: { ...TRANSIENT_RETRY_POLICY, nonRetryableErrorTypes: ['SkillConfigError'] },
  });

  // Freshness-check proxy — checkFreshness only stats a few files but it
  // can target a workspace that's slow to mount immediately post-resume.
  // 2-min ceiling matches the activity heartbeat budget; transient retry
  // because we'd rather wait than skip the backprop scan.
  const freshnessActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: '2m',
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

  // Merge `sop: vars:` skill-level defaults under the caller-supplied
  // templateVars. Precedence matches the python engine: caller (cli /
  // inputs file equivalent) wins over sop.vars, which wins over engine
  // builtins (already handled in the parser). See
  // engine.parser._find_and_load_template_vars (tne-plugins #2018).
  // We compute this once and thread it through every step builder so
  // an inline step's manifest sees the same view as a child workflow
  // dispatched for a leaf.
  const mergedTemplateVars: Record<string, string> = {
    ...(config.vars || {}),
    ...(input.templateVars || {}),
    // Builtin: the run's id, exposed to every step (incl. command-mode env) so
    // a step can address its own run — e.g. push output to the chat thread via
    // orion's render-to-chat, or (0b) build a unique OUTPUT_BASENAME.
    RUN_ID: input.runId,
  };

  // Fold the runtime-only RUN_ID into OUTPUT_BASENAME so the basename is
  // concrete for verbatim-copy consumers (per-step "Run Variables" list +
  // command-step env), not just lazy output-path resolution. RUN_ID is injected
  // here at runtime, AFTER the parser bakes sop.vars, so a sop.var referencing
  // {{RUN_ID}} otherwise reaches command steps literal (observed crashing
  // lifecycle.py: runs_dir ".../yes-p-cvc-council-{{RUN_ID}}"). Scoped to the
  // {{RUN_ID}} token: a no-op for every SOP whose OUTPUT_BASENAME lacks it
  // (every fleet except p-cvc-council today). Pure string op -> deterministic.
  const _obn = mergedTemplateVars['OUTPUT_BASENAME'];
  if (_obn && _obn.includes('{{RUN_ID}}')) {
    mergedTemplateVars['OUTPUT_BASENAME'] = _obn.replaceAll('{{RUN_ID}}', input.runId);
  }

  // Initialize or resume state
  const state: FsmWorkflowState = input.resumeState || initializeState(config);

  // ── Backprop · freshness check on resume ────────────────────────────────
  // Mirrors tne-engine's `propagation.check_freshness` (Python). When the
  // workflow resumes (continueAsNew tick OR external resume after a pod
  // restart), walk every previously-COMPLETE step's recorded mtimes.
  // External edits to outputs OR inputs newer than the recorded output
  // mark the owning step STALE; `propagateForward` then cascades to every
  // transitive dependent so we don't compute downstream artifacts off
  // outdated inputs. First-run state has nothing to check — skip.
  if (input.resumeState) {
    const recorded: FreshnessCheckParams['recorded'] = {};
    for (const [k, ss] of Object.entries(state.steps)) {
      if (ss.status !== StepStatus.COMPLETE) continue;
      if (!ss.outputMtime && !ss.inputMtimes) continue;
      recorded[k] = { outputPath: ss.outputPath, outputMtime: ss.outputMtime, inputMtimes: ss.inputMtimes };
    }
    if (Object.keys(recorded).length > 0) {
      try {
        const fresh = await freshnessActivities.checkFreshness({
          runId: input.runId,
          workspacePath: input.workspacePath,
          workingDir: input.workingDir,
          recorded,
        });
        const stale = new Set<string>([...fresh.externallyModified, ...fresh.inputsNewer]);
        for (const key of stale) {
          const ss = state.steps[key];
          if (ss) ss.status = StepStatus.STALE;
        }
        if (stale.size > 0) propagateForward(state, stale, config);
      } catch (err) {
        // Freshness scan is best-effort — log + continue with prior state.
        console.warn('[FsmProcessWorkflow] checkFreshness failed (non-fatal):', err);
      }
    }
  }

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

  // User flipped the auto-approve toggle. With no payload (legacy callers
  // and the original UI) we enable, which both releases any in-flight
  // gate and skips every future one. With `{ enabled: false }` we flip
  // back to manual — but we deliberately do NOT synthesize an approval
  // here. The intent of disabling is "ask me again", so a gate currently
  // blocked stays blocked until the user explicitly approves or rejects.
  setHandler(autoApproveSignal, (payload) => {
    const enabled = payload?.enabled ?? true;
    autoApprove = enabled;
    if (enabled) approvalReceived = true;
  });

  // Register query handlers
  setHandler(getStateQuery, () => state);
  setHandler(getPhaseQuery, () => state.phase);
  setHandler(getAutoApproveQuery, () => autoApprove);

  // ── Step execution helpers (parity with engine.temporal_workflow) ─────
  //
  // runStepUnified wraps the per-step dispatch decision so the four serial
  // call sites in this workflow stay tidy:
  //   - step.tneEngine = true (and step.run !== 'subagent')
  //       → dispatch FsmProcessWorkflow as a child workflow with bounded
  //         iterations. Mirrors engine.temporal_workflow's tne-engine leaf
  //         branch (tne-plugins #2060).
  //   - otherwise
  //       → call executeStep activity with an optional per-step
  //         startToCloseTimeout override (engine.schema.Step.timeout).
  //
  // Both the sequential call sites (runStepUnified) and the parallel runner
  // (runPhaseParallel) route their per-step dispatch through dispatchStep, so
  // tne-engine child-workflow dispatch and per-step timeout overrides apply
  // uniformly regardless of execution shape.
  //
  // dispatchStep is the dispatch core: given a step and its fully-built
  // StepExecutionParams it decides HOW to run the step —
  //   - step.tneEngine = true (and step.run !== 'subagent')
  //       → dispatch FsmProcessWorkflow as a child workflow with bounded
  //         iterations. Mirrors engine.temporal_workflow's tne-engine leaf
  //         branch (tne-plugins #2060).
  //   - step.timeout > 0
  //       → call executeStep through a one-off proxy with the overridden
  //         startToCloseTimeout (engine.schema.Step.timeout).
  //   - otherwise
  //       → call the workflow-level executeStep proxy.
  async function dispatchStep(step: Step, stepParams: StepExecutionParams): Promise<StepResult> {
    // phase_gate enforcement: skip steps whose phaseGate excludes the current PHASE
    // without dispatching an agent (deterministic; no skip-stub artifact). Parity with
    // engine.temporal_workflow's phase-gate skip. The synthesized success marks the step
    // completed so dependency barriers still resolve.
    const phaseGatePhase = mergedTemplateVars['PHASE'] ?? '';
    if (
      step.phaseGate &&
      step.phaseGate.length > 0 &&
      phaseGatePhase &&
      !step.phaseGate.includes(phaseGatePhase)
    ) {
      console.log(
        `[FsmProcessWorkflow] phase-gate skip step ${step.number} (skill=${step.skill}) — PHASE=${phaseGatePhase} not in [${step.phaseGate.join(', ')}]`,
      );
      return { success: true, gateResults: {} };
    }

    // tne-engine leaf opt-in: declared by the leaf SKILL.md's top-level
    // `tne-engine: true` frontmatter, surfaced as Step.tneEngine by the
    // parser. Skip when this is itself a subagent step — those are
    // already nested orchestrators and python treats them separately.
    // (The `step.run !== 'subagent'` guard was documented above but missing
    // from the condition: the app-foundry blueprint step is `run: subagent`
    // AND its leaf p-cpo16 declares `tne-engine: true`, so it was wrongly
    // dispatched as a nested child FsmProcessWorkflow — compounding the
    // blueprint re-evaluation loop — instead of a scoped subagent turn.)
    if (step.tneEngine && step.skill && step.skill !== 'inline' && step.run !== 'subagent') {
      const wfRun = workflowInfo().runId;
      const childWorkflowId = `${wfRun.slice(0, 8)}-${step.skill}`;
      const childInput: FsmProcessInput = {
        runId: childWorkflowId,
        skillName: step.skill,
        templateVars: mergedTemplateVars,
        workspacePath: input.workspacePath,
        workingDir: input.workingDir,
        userId: input.userId,
        autoApprove: true, // leaves don't gate (matches python leaf params)
        s3Bucket: input.s3Bucket,
        s3Prefix: input.s3Prefix,
        agentBackend: input.agentBackend,
        delegateModel: input.delegateModel,
        delegateProvider: input.delegateProvider,
        toolHarness: input.toolHarness,
        githubToken: input.githubToken,
        maxIterations: step.tneEngineMaxIterations || 3,
      };
      const timeoutSec = step.timeout && step.timeout > 0 ? step.timeout : 0;
      try {
        await executeChild(FsmProcessWorkflow, {
          args: [childInput],
          workflowId: childWorkflowId,
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          ...(timeoutSec > 0 ? { workflowExecutionTimeout: `${timeoutSec}s` } : {}),
        });
        // Synthesize a successful StepResult so the surrounding state
        // machine doesn't need to special-case child workflows. The leaf
        // child wrote its outputs to S3 inside the child workflow; the
        // parent doesn't snapshot mtimes for it (mirrors python).
        return { success: true, gateResults: {} };
      } catch (err: any) {
        return {
          success: false,
          error: `[tne-engine leaf child workflow ${childWorkflowId} failed: ${err?.message ?? String(err)}]`,
          gateResults: {},
        };
      }
    }

    // Per-step Temporal activity timeout. When step.timeout > 0 we create
    // a one-off proxy with the overridden startToCloseTimeout; otherwise
    // the workflow-level executeStep proxy (STEP_ACTIVITY_TIMEOUT) applies.
    // Per-step proxy is required because @temporalio/workflow's
    // proxyActivities options are baked into the proxy — there's no
    // per-call override on the returned proxy fn.
    if (step.timeout && step.timeout > 0) {
      const perStepProxy = proxyActivities<typeof activities>({
        startToCloseTimeout: `${step.timeout}s`,
        heartbeatTimeout: STEP_HEARTBEAT_TIMEOUT,
        // BOUNDED retry (not the default unbounded STEP_RETRY_POLICY): a step
        // author sets an explicit `timeout` to bound the step, so a startToClose
        // timeout should fail-fast, not retry forever. The unbounded policy here
        // turned a too-short `timeout` (e.g. the app-foundry blueprint's old
        // 120s) into an infinite ~every-timeout re-invocation loop — the
        // activity timed out just after writing its output and got re-run
        // endlessly. Cap at 3 attempts: still absorbs a one-off slow turn, but
        // a persistently-over-budget step surfaces as a failure instead of a loop.
        retry: { ...STEP_RETRY_POLICY, maximumAttempts: 3 },
      });
      return perStepProxy.executeStep(stepParams);
    }
    return executeStep(stepParams);
  }

  // runStepUnified wraps dispatchStep for the four serial call sites: it
  // builds the StepExecutionParams (including mergedTemplateVars) and then
  // hands off to dispatchStep.
  async function runStepUnified(
    step: Step,
    iteration: number,
    feedback: string | undefined,
    overridePhase?: 'preamble' | 'generator' | 'evaluator' | 'postamble',
  ): Promise<StepResult> {
    const stepParams = buildStepParams(
      step,
      iteration,
      input,
      config,
      state,
      feedback,
      overridePhase,
      undefined,
      undefined,
      mergedTemplateVars,
    );
    return dispatchStep(step, stepParams);
  }

  // Per-step review pause (parity with engine.temporal_workflow per_step_review,
  // tne-plugins #1975). Python pauses after every successful step when
  // config.per_step_review is true and !auto_approve, regardless of phase
  // (preamble included). It also honours skill-requested pauses via the
  // activity's stage_review_pause flag, but that signal isn't propagated
  // through svc-temporal's StepResult today — a separate plumbing change.
  // For this PR we only honour config.perStepReview.
  //
  // config.stageReview keeps its existing svc-temporal semantics (a coarser
  // preamble-only gate fired by the caller before this pause runs); this
  // function is gated on a different flag so the two never double up on
  // the preamble path.
  async function maybePerStepReviewPause(
    step: Step,
    phase: 'preamble' | 'generator' | 'evaluator' | 'postamble',
    result: StepResult,
  ): Promise<'continue' | 'cancelled'> {
    if (!result.success) return 'continue';
    if (autoApprove) return 'continue';
    if (!config.perStepReview) return 'continue';
    const stepKey = `${phase}.${step.number}`;
    state.steps[stepKey] = state.steps[stepKey] || {
      status: StepStatus.AWAITING_REVIEW,
      retries: 0,
    };
    state.steps[stepKey]!.status = StepStatus.AWAITING_REVIEW;
    await syncBeforeGate(syncActivities, input);
    approvalReceived = false;
    await condition(() => approvalReceived || cancelled, '7 days');
    if (cancelled) return 'cancelled';
    state.steps[stepKey]!.humanNotes = approvalNotes;
    state.steps[stepKey]!.status = StepStatus.COMPLETE;
    return 'continue';
  }

  // Drive per-step review pauses for a parallel wave: after the wave's
  // outcomes are committed, pause sequentially for each succeeded step.
  // maybePerStepReviewPause only reads result.success, so a minimal
  // successful stub is sufficient here.
  async function runWaveReviewPauses(
    phase: 'preamble' | 'generator' | 'evaluator' | 'postamble',
    completedSteps: Step[],
  ): Promise<'continue' | 'cancelled'> {
    for (const step of completedSteps) {
      const outcome = await maybePerStepReviewPause(step, phase, { success: true, gateResults: {} });
      if (outcome === 'cancelled') return 'cancelled';
    }
    return 'continue';
  }

  // ─── PREAMBLE ──────────────────────────────────────────────────────────

  if (state.phase === Phase.INIT || state.phase === Phase.PREAMBLE) {
    state.phase = Phase.PREAMBLE;

    for (const step of config.preamble) {
      if (cancelled) return { status: 'cancelled', state };

      const stepKey = `preamble.${step.number}`;
      const stepState = state.steps[stepKey];

      // Skip already completed steps (resume case)
      if (stepState?.status === StepStatus.COMPLETE) continue;

      const result = await runStepUnified(step, 0, undefined, 'preamble');
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

      // Skill- or config-requested per-step review. config.stageReview
      // above is a coarser preamble-only gate that already pauses here;
      // maybePerStepReviewPause is a no-op in preamble unless
      // config.perStepReview is true, so the two don't double up.
      const reviewOutcome = await maybePerStepReviewPause(step, 'preamble', result);
      if (reviewOutcome === 'cancelled') return { status: 'cancelled', state };
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
    // ── Backprop · stale-replay pass ────────────────────────────────────
    // Any preamble step the prior iteration's `handleBackprop` (or a
    // resume freshness check) flagged STALE re-runs here, BEFORE the
    // generator phase, so downstream output picks up the corrected
    // preamble artifact. Feedback stashed on the stale step (set by
    // `handleBackprop`) gets prepended to the new prompt via
    // `collectStaleFeedback`, mirroring tne-engine's behavior.
    for (const step of config.preamble) {
      if (cancelled) return { status: 'cancelled', state };
      const stepKey = `preamble.${step.number}`;
      if (state.steps[stepKey]?.status !== StepStatus.STALE) continue;
      const replayFeedback = state.steps[stepKey]?.feedback;
      const replayResult = await runStepUnified(step, state.iteration, replayFeedback, 'preamble');
      updateStepState(state, stepKey, replayResult);
      if (!replayResult.success) return { status: 'failed', state };
    }

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
        'generator', config.generator, input, config, state, dispatchStep,
        state.iteration, feedback, () => cancelled,
        (data) => eventActivities.emitFsmEventActivity({ runId: input.runId, type: 'step_cancelled', data }),
        mergedTemplateVars,
        (completedSteps) => runWaveReviewPauses('generator', completedSteps),
      );
      if (cancelled) return { status: 'cancelled', state };
      if (outcome.failed) {
        return { status: 'failed', state };
      }
    } else {
      for (const step of config.generator) {
        if (cancelled) return { status: 'cancelled', state };

        const stepKey = `generator.${step.number}`;
        const result = await runStepUnified(step, state.iteration, feedback, 'generator');
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

        const reviewOutcome = await maybePerStepReviewPause(step, 'generator', result);
        if (reviewOutcome === 'cancelled') return { status: 'cancelled', state };
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

        const result = await runStepUnified(step, state.iteration, undefined, 'evaluator');
        updateStepState(state, stepKey, result);

        if (!result.success) {
          allPassed = false;
          stoppingEvaluator = step.skill;
          keyIssues.push(result.feedback || result.error || 'Evaluator failed');

          if (config.evaluatorMode === EvaluatorMode.FAIL_FAST) break;
        } else {
          const reviewOutcome = await maybePerStepReviewPause(step, 'evaluator', result);
          if (reviewOutcome === 'cancelled') return { status: 'cancelled', state };
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

    // ── Backprop · evaluator-driven ─────────────────────────────────────
    // Scan the evaluators' combined feedback for an explicit or inferred
    // backprop target (e.g. `backprop_to: preamble.2`). When matched,
    // mark the target STALE + cascade to dependents — the next iteration
    // of this loop replays it before re-running the generator. No-op
    // when the feedback doesn't name a target; the generator just iterates
    // normally with the evaluator feedback as before.
    handleBackprop(state, keyIssues.join('\n'), config);

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
      const outcome = await runPhaseParallel(
        'postamble', config.postamble, input, config, state, dispatchStep,
        0, undefined, () => cancelled,
        (data) => eventActivities.emitFsmEventActivity({ runId: input.runId, type: 'step_cancelled', data }),
        mergedTemplateVars,
        (completedSteps) => runWaveReviewPauses('postamble', completedSteps),
      );
      if (cancelled) return { status: 'cancelled', state };
      // Propagate postamble failures up. Without this the workflow returned
      // `status: 'completed'` even when every postamble step failed, which:
      //   (a) made the orion-side delegate-fallback retry skip the run
      //       (the watcher only retries when dbStatus !== 'completed'); and
      //   (b) misled the UI into showing the parent run as completed while
      //       each step card carried a fail message.
      // Mirrors the generator parallel-runner branch above.
      if (outcome.failed) {
        return { status: 'failed', state };
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
  templateVarsOverride?: Record<string, string>,
): StepExecutionParams {
  const phase = overridePhase || (stepPhase(step, config) as 'preamble' | 'generator' | 'evaluator' | 'postamble');
  const effectiveTemplateVars = templateVarsOverride ?? input.templateVars;
  // Per-step model routing.
  //
  // A SKILL.md step may declare its own `model:` — a concrete id, an alias, a
  // tier key ('opus'/'glm-5.2'/'kimi-k2.6'), or a template var ({{HIGH_MODEL}})
  // that resolves against the run's templateVars. We resolve+substitute it here
  // and give it PRECEDENCE over the job-wide delegate/tier model. That is what
  // makes a genuine per-step A/B possible: e.g. the decompose skill's reference
  // step runs on {{HIGH_MODEL}} (opus) while its low-tier chain step runs on
  // {{LOW_MODEL}} (glm-5.2), even though the job's single tier model is sonnet.
  //
  // Precedence (highest first):
  //   1. declared per-step model (SKILL.md `model:` / Model column), resolved
  //   2. input.delegateModel — per-user "all my workers run on X" override
  //   3. step.model as-authored (legacy: usually empty → default agent model)
  //
  // Backward compatible: a step with no `model:` and no delegateModel is
  // untouched; a plain delegateModel run still applies to every step that
  // doesn't declare its own model.
  //
  // Substitution is done inline here (a tiny replaceAll loop, matching the
  // OUTPUT_BASENAME handling above) rather than via the config `templateResolver`
  // — that module imports `fs` and must not be pulled into the workflow sandbox.
  // The tier-key ('opus'/'glm-5.2'/'kimi-k2.6') → concrete-model-id mapping is
  // applied later, on the activity side (invokeSkill → resolveTierModel), where
  // env lookups are allowed; the workflow only decides WHICH string wins.
  let perStepModel = '';
  if (step.model) {
    let substituted = step.model;
    for (const [k, v] of Object.entries(effectiveTemplateVars || {})) {
      if (k === 'ITER') continue;
      substituted = substituted.replaceAll(`{{${k}}}`, v).replaceAll(`{${k}}`, v);
    }
    substituted = substituted.trim();
    // Only treat as concrete when every template var resolved (no leftover
    // {{…}} / {…}). An unresolved var means the run didn't supply it — fall
    // through to the delegate/default rather than sending a literal placeholder.
    if (substituted && !/\{\{?[A-Za-z0-9_-]+\}?\}/.test(substituted)) {
      perStepModel = substituted;
    }
  }
  const effectiveModel = perStepModel || input.delegateModel || step.model;
  const effectiveStep: Step = effectiveModel !== step.model
    ? { ...step, model: effectiveModel }
    : step;
  return {
    step: effectiveStep,
    iteration,
    templateVars: templateVarsOverride ?? input.templateVars,
    feedback,
    humanNotes: state.steps[`${phase}.${step.number}`]?.humanNotes,
    workspacePath: input.workspacePath,
    workingDir: input.workingDir,
    projectWorkingDirs: input.projectWorkingDirs,
    agentBackend: input.agentBackend,
    toolHarness: input.toolHarness,
    githubToken: input.githubToken,
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
    // Snapshot the activity-recorded mtimes so a future resume's
    // freshness check has a baseline. Only set when present — preserving
    // any prior values on a re-run that didn't write the output (e.g.
    // gate-cascade infra error).
    ...(result.outputMtime != null ? { outputMtime: result.outputMtime } : {}),
    ...(result.inputMtimes ? { inputMtimes: result.inputMtimes } : {}),
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
  /** Per-step dispatch closure (the workflow's dispatchStep). Routes each
   *  wave step through the same per-step timeout / tne-engine child-workflow
   *  logic as the sequential path. */
  dispatchStep: (step: Step, params: StepExecutionParams) => Promise<StepResult>,
  iteration: number,
  feedback: string | undefined,
  isCancelled: () => boolean,
  emitCancelEvent: (data: Record<string, any>) => Promise<void>,
  /** sop.vars-merged template_vars threaded through so inline manifest
   *  expansion matches the serial path. */
  templateVarsOverride?: Record<string, string>,
  /** Called after each wave's outcomes are committed to state, with the
   *  steps that succeeded in that wave. Used to drive per-step review pauses
   *  sequentially after a parallel wave (you can't pause inside Promise.all).
   *  Returning 'cancelled' aborts the phase with `failed: true`. */
  onWaveComplete?: (completedSteps: Step[]) => Promise<'continue' | 'cancelled'>,
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
  const isSatisfied = (dep: ParsedDep, selfNumber: string): boolean =>
    isDepSatisfied(dep, selfNumber, steps, completed, state.steps);

  const isBlockedByFailure = (dep: ParsedDep, selfNumber: string): boolean =>
    isDepBlockedByFailure(dep, selfNumber, steps, failed, cancelledSteps, state.steps);

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
              // Route through the workflow's dispatchStep so each wave step
              // gets the same per-step timeout overrides and tne-engine
              // child-workflow dispatch as the sequential path. Per-step
              // review pauses can't run inside a Promise.all wave, so they're
              // handled after the wave via the onWaveComplete callback below.
              const result = await dispatchStep(
                step,
                buildStepParams(step, iteration, input, config, state, feedback, phaseKey, isFanOut, waveIdx, templateVarsOverride),
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
    const waveSucceeded: Step[] = [];
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
        if (result.success) {
          completed.add(step.number);
          waveSucceeded.push(step);
        } else {
          failed.add(step.number);
        }
      }
    }

    // Per-step review after the wave: pause sequentially for each step that
    // succeeded (parity with the sequential path's maybePerStepReviewPause).
    if (onWaveComplete && waveSucceeded.length > 0) {
      const outcome = await onWaveComplete(waveSucceeded);
      if (outcome === 'cancelled') return { failed: true };
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
