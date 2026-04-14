/**
 * LongRunningJobWorkflow — generic long-running job for Horizon.
 *
 * Wraps Horizon's existing JobService pattern: runs a Claude Agent SDK task
 * with durable execution via Temporal. Supports approval signals, progress
 * queries, and S3 output sync.
 */

import {
  condition,
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
} from '@temporalio/workflow';

import type { JobInput, JobResult, ApprovalSignalPayload } from '../shared/types.js';

import type * as activities from '../activities/index.js';

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
    startToCloseTimeout: '8h',
    heartbeatTimeout: '120s',
    retry: {
      maximumAttempts: 3,
      initialInterval: '10s',
      backoffCoefficient: 2,
    },
  });

  // Separate proxy for sync activities with shorter timeout
  const syncActivities = proxyActivities<typeof activities>({
    startToCloseTimeout: '15m',
    heartbeatTimeout: '60s',
    retry: { maximumAttempts: 2, initialInterval: '5s', backoffCoefficient: 2 },
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

  // ── Step 1: Pull user workspace from S3 ────────────────────────────────
  const workspacePath = `/tmp/temporal-jobs/${input.jobId}`;
  const outputFolder = input.outputFolder || `jobs/${input.jobId}`;

  if (input.s3Bucket && input.s3Prefix) {
    statusMessage = 'Syncing workspace from S3...';
    progress = 5;
    try {
      await syncActivities.pullWorkspaceFromS3({
        bucket: input.s3Bucket,
        prefix: input.s3Prefix,
        localPath: workspacePath,
        scopePath: outputFolder,
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
      number: 0,
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
    },
    input.prompt,
    workspacePath,
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
        scopePath: outputFolder,
      });
    } catch {
      // Non-fatal
    }
  }

  progress = 100;
  statusMessage = result.success ? 'Complete' : 'Failed';

  return {
    status: result.success ? 'completed' : 'failed',
    output: result.stdout,
  };
}
