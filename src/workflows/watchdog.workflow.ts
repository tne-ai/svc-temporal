/**
 * WatchdogWorkflow — scheduled runner for w-* skills.
 *
 * Parity wrapper around FsmProcessWorkflow that runs a single w-* skill
 * unattended (autoApprove=true) on a Temporal schedule. Mirrors the
 * Python `WatchdogWorkflow` in tne-plugins/plugins/tne/engine/temporal_workflow.py
 * so a watchdog SKILL.md authored for one engine fires the same way here.
 *
 * Registration via Temporal Schedule (one-shot, from the cluster):
 *
 *   temporal schedule create \
 *     --schedule-id watchdog-w-cai-ethos4 \
 *     --workflow-type WatchdogWorkflow \
 *     --task-queue tne-fsm-queue \
 *     --interval 1d \
 *     --input '{"skill":"w-cai-ethos4-watch-rules","userId":"svc"}'
 *
 * Or via the helper: `yarn schedule create watchdog --skill w-cai-ethos4 --user svc --interval 1d`.
 */
import {
  executeChild,
  defineQuery,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type {
  FsmProcessInput,
  FsmProcessResult,
  WatchdogInput,
  WatchdogResult,
} from '../shared/types.js';

export const getWatchdogStatusQuery = defineQuery<{
  skill: string;
  childWorkflowId: string;
  phase: 'starting' | 'running' | 'done';
}>('getWatchdogStatus');

export async function WatchdogWorkflow(input: WatchdogInput): Promise<WatchdogResult> {
  const info = workflowInfo();
  // Short suffix from the parent run id keeps child wf ids unique across
  // each schedule firing (Temporal mints a new run_id per fire) without
  // depending on wall-clock time inside the workflow sandbox.
  const shortRunId = info.runId.slice(0, 8);
  const runId = `watchdog-${input.skill}-${shortRunId}`;
  const childWorkflowId = `fsm-${runId}`;

  let phase: 'starting' | 'running' | 'done' = 'starting';
  setHandler(getWatchdogStatusQuery, () => ({
    skill: input.skill,
    childWorkflowId,
    phase,
  }));

  const fsmInput: FsmProcessInput = {
    runId,
    skillName: input.skill,
    // Python passes dry_run as a first-class FSM param; svc-temporal's
    // FsmProcessInput has no dryRun field, so surface it as a templateVar
    // the skill can read (`{{dry_run}}`). Slight semantic gap with the
    // Python engine — documented here so a future first-class dryRun
    // field on FsmProcessInput knows what to absorb.
    templateVars: input.dryRun ? { dry_run: 'true' } : {},
    // Default to "." (cwd of the worker activity) to match Python's
    // `project_dir = params.project_dir or "."`. A watchdog that
    // inspects "the repo I'm running against" then sees real files
    // instead of an empty tmp dir. Callers that want isolation pass
    // an absolute path explicitly.
    workspacePath: input.workspacePath ?? '.',
    workingDir: input.workingDir,
    userId: input.userId,
    autoApprove: true,
    // One-shot semantics — caps the FSM's generator↔evaluator loop at
    // a single iteration. Matches Python's WatchdogWorkflow which
    // passes `max_iterations=1` to its child ProcessWorkflow.
    maxIterations: 1,
    s3Bucket: input.s3Bucket,
    s3Prefix: input.s3Prefix,
    agentBackend: input.agentBackend,
  };

  phase = 'running';
  const fsmResult = await executeChild<(i: FsmProcessInput) => Promise<FsmProcessResult>>(
    'FsmProcessWorkflow',
    {
      taskQueue: info.taskQueue,
      workflowId: childWorkflowId,
      args: [fsmInput],
      // 30-min hard cap on the child — matches Python's
      // `execution_timeout=timedelta(minutes=30)`. Without this a
      // misbehaving watchdog could spin indefinitely on its schedule
      // and starve the FSM queue.
      workflowExecutionTimeout: '30m',
    },
  );

  phase = 'done';
  return {
    skill: input.skill,
    status: fsmResult.status,
    state: fsmResult.state,
  };
}
