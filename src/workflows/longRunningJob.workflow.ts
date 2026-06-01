/**
 * LongRunningJobWorkflow — generic long-running job for Horizon.
 *
 * Wraps Horizon's existing JobService pattern: runs a Claude Agent SDK task
 * with durable execution via Temporal. Supports approval signals, progress
 * queries, and S3 output sync.
 */

import {
  condition,
  executeChild,
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
} from '@temporalio/workflow';

import type {
  ApprovalSignalPayload,
  FsmProcessInput,
  FsmProcessResult,
  JobInput,
  JobResult,
} from '../shared/types.js';

import type * as activities from '../activities/index.js';
import {
  STEP_ACTIVITY_TIMEOUT,
  STEP_HEARTBEAT_TIMEOUT,
  STEP_RETRY_POLICY,
  TRANSIENT_RETRY_POLICY,
  WORKSPACE_SYNC_TIMEOUT,
} from '../shared/constants.js';

// Signals
export const approveJobSignal = defineSignal<[ApprovalSignalPayload]>('approveJob');
export const cancelJobSignal = defineSignal('cancelJob');

// Queries
export const getJobStatusQuery = defineQuery<{
  status: string;
  progress: number;
  message?: string;
}>('getJobStatus');

export async function LongRunningJobWorkflow(input: JobInput): Promise<JobResult> {
  const { invokeSkill } = proxyActivities<typeof activities>({
    startToCloseTimeout: STEP_ACTIVITY_TIMEOUT,
    heartbeatTimeout: STEP_HEARTBEAT_TIMEOUT,
    retry: STEP_RETRY_POLICY,
  });

  // Separate proxy for sync activities (unbounded retry via TRANSIENT_RETRY_POLICY).
  const syncActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: WORKSPACE_SYNC_TIMEOUT,
    heartbeatTimeout: '5m',
    retry: TRANSIENT_RETRY_POLICY,
  });

  let status = 'running';
  let progress = 0;
  let cancelled = false;
  let approvalReceived = false;
  let statusMessage = 'Initializing...';

  setHandler(approveJobSignal, () => { approvalReceived = true; });
  setHandler(cancelJobSignal, () => { cancelled = true; });
  setHandler(getJobStatusQuery, () => ({ status, progress, message: statusMessage }));

  if (cancelled) {
    return { status: 'failed', output: 'Job cancelled before start' };
  }

  // ── Skill dispatch: delegate to FsmProcessWorkflow as a child ──────────
  // When the job was created via /api/jobs/skill-run (skillName set and a
  // ProcessRun row pre-created), run the skill through the FSM engine on
  // tne-fsm-queue rather than the generic agent-task path. The child writes
  // its own workspace sync, progress events, and approval signals — the
  // parent just awaits and summarizes.
  if (input.skillName && input.processRunId) {
    statusMessage = `Running skill ${input.skillName}...`;
    progress = 10;
    const fsmWorkspacePath =
      input.workspacePath ?? `/tmp/claude-agent-s3/${input.workspaceId}`;
    const fsmInput: FsmProcessInput = {
      runId: input.processRunId,
      skillName: input.skillName,
      templateVars: {},
      workspacePath: fsmWorkspacePath,
      workingDir: input.workingDir,
      userId: input.userId,
      autoApprove: input.autoApprove ?? false,
      s3Bucket: input.s3Bucket,
      s3Prefix: input.s3Prefix,
      agentBackend: input.agentBackend,
      // Forward the resolved tool-harness so executeStep can pick Pi vs
      // Claude SDK for each step. LiteLLM is always-on as transport.
      toolHarness: input.toolHarness,
    };
    try {
      const fsmResult = await executeChild<(i: FsmProcessInput) => Promise<FsmProcessResult>>(
        'FsmProcessWorkflow',
        {
          taskQueue: 'tne-fsm-queue',
          workflowId: `fsm-${input.processRunId}`,
          args: [fsmInput],
        },
      );
      progress = 100;
      const terminal: 'completed' | 'failed' =
        fsmResult.status === 'completed' ? 'completed' : 'failed';
      status = terminal;
      statusMessage = terminal === 'completed' ? 'Complete' : 'Failed';
      return {
        status: terminal,
        output:
          `FSM ${fsmResult.status}. Final phase: ${fsmResult.state.phase}, ` +
          `iteration: ${fsmResult.state.iteration}.`,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        output: `FSM child workflow error: ${err?.message ?? String(err)}`,
      };
    }
  }

  // ── Completion mode: single model call, no tools, no workspace ─────────
  // For single-shot "prompt → answer/JSON" jobs (compass-helm analyzer,
  // briefing, relevance, audit, …). Skips S3 sync entirely and runs ONE
  // turn with no tools. Still Temporal-durable/retried like any job; only
  // the executor differs. `skillName` (when set) loads the leaf output
  // schema for Structured Outputs on the claude_sdk backend.
  if (input.completionMode) {
    statusMessage = 'Running completion...';
    progress = 20;
    const result = await invokeSkill(
      {
        number: '0',
        skill: input.skillName || 'completion',
        inputs: [],
        output: '',
        verify: '',
        run: '',
        notes: '',
        passCondition: '',
        stageType: 'default' as any,
        dependsOn: [],
        backpropSkill: '',
        failFast: { maxRetries: 0, gates: [] },
        permissionMode: 'bypassPermissions',
        model: input.model || '',
        timeout: 0,
        tneEngine: false,
        tneEngineMaxIterations: 1,
      },
      input.prompt,
      `/tmp/temporal-jobs/${input.jobId}`,
      input.agentBackend,
      { jobId: input.jobId, userId: input.userId, toolHarness: input.toolHarness, completion: true },
    );
    progress = 100;
    status = result.success ? 'completed' : 'failed';
    statusMessage = result.success ? 'Complete' : 'Failed';
    return {
      status: result.success ? 'completed' : 'failed',
      output: result.success ? result.stdout : (result.stderr || result.stdout || 'Unknown error'),
    };
  }

  // ── Step 1: Pull user workspace from S3 ────────────────────────────────
  // Two scope modes:
  //   workingDir present: behave like FsmProcessWorkflow — pull/push the
  //     user's actual subtree (e.g. `test1/`), agent runs cwd=workspace/test1.
  //     This is the "job operates on the user's files in the dir they're
  //     looking at" mode.
  //   workingDir absent: legacy mode — scope to `outputFolder` (default
  //     `jobs/<jobId>`), keeping the job's writes isolated from the user's
  //     main tree. Used by quick-fire chat jobs that don't have a session
  //     working directory.
  const workspacePath = `/tmp/temporal-jobs/${input.jobId}`;
  const outputFolder = input.outputFolder || `jobs/${input.jobId}`;
  // S3 scope under the user's prefix. Push uses prefix=s3Prefix +
  // scopePath= so the key composes as `<userId>/<scopePath>/<relFile>`.
  // Crucially we don't fold scopePath into prefix — pushWorkspaceToS3
  // joins them itself (see workspaceSync.ts:398), so doubling the prefix
  // would land everything at `<userId>/<scope>/<scope>/<file>`.
  const s3Scope = input.workingDir || outputFolder;

  if (input.s3Bucket && input.s3Prefix) {
    statusMessage = 'Syncing workspace from S3...';
    progress = 5;
    try {
      await syncActivities.pullWorkspaceFromS3({
        bucket: input.s3Bucket,
        prefix: input.s3Prefix,
        localPath: workspacePath,
        scopePath: s3Scope,
      });
    } catch {
      // Non-fatal — workspace may be empty for new jobs
    }
    progress = 10;
  }

  // ── Step 2: Invoke the agent task ──────────────────────────────────────
  statusMessage = 'Running agent...';

  const result = await invokeSkill(
    {
      number: '0',
      skill: 'agent-task',
      inputs: [],
      output: '',
      verify: '',
      run: '',
      notes: '',
      passCondition: '',
      stageType: 'default' as any,
      dependsOn: [],
      backpropSkill: '',
      failFast: { maxRetries: 0, gates: [] },
      permissionMode: 'bypassPermissions',
      model: input.model || '',
      timeout: 0,
      tneEngine: false,
      tneEngineMaxIterations: 3,
    },
    input.prompt,
    workspacePath,
    input.agentBackend,
    // Pass jobId so the agent loop emits structured events to orion's
    // per-job SSE stream — the Jobs panel renders them as tool_use /
    // tool_result rows the same way FSM runs render their event stream.
    // workingDir gets the agent's cwd into the user's actual subdir
    // (matching what they see in the editor) instead of the workspace root.
    // toolHarness: per-run Pi vs Claude SDK choice — forwarded so the
    // agent-task path (no skillName, direct invokeSkill call) routes
    // the same way the FSM-child path does.
    {
      jobId: input.jobId, userId: input.userId,
      s3Bucket: input.s3Bucket, s3Prefix: input.s3Prefix,
      workingDir: input.workingDir,
      toolHarness: input.toolHarness,
    },
  );

  progress = 90;
  status = result.success ? 'completed' : 'failed';

  // ── Step 3: Push results back to S3 ────────────────────────────────────
  if (input.s3Bucket && input.s3Prefix) {
    statusMessage = 'Syncing results to S3...';
    try {
      await syncActivities.pushWorkspaceToS3({
        bucket: input.s3Bucket,
        prefix: input.s3Prefix,
        localPath: workspacePath,
        scopePath: s3Scope,
      });
    } catch {
      // Non-fatal
    }
  }

  progress = 100;
  statusMessage = result.success ? 'Complete' : 'Failed';

  return {
    status: result.success ? 'completed' : 'failed',
    output: result.success ? result.stdout : (result.stderr || result.stdout || 'Unknown error'),
  };
}
