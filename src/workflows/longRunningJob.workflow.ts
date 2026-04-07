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
  const { invokeSkill, syncToS3 } = proxyActivities<typeof activities>({
    startToCloseTimeout: '8h',
    heartbeatTimeout: '120s',
    retry: {
      maximumAttempts: 3,
      initialInterval: '10s',
      backoffCoefficient: 2,
    },
  });

  let status = 'running';
  let progress = 0;
  let cancelled = false;
  let approvalReceived = false;

  setHandler(approveJobSignal, () => { approvalReceived = true; });
  setHandler(cancelJobSignal, () => { cancelled = true; });
  setHandler(getJobStatusQuery, () => ({ status, progress }));

  if (cancelled) {
    return { status: 'failed', output: 'Job cancelled before start' };
  }

  // Invoke the agent task
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
  );

  progress = 100;
  status = result.success ? 'completed' : 'failed';

  // Sync output files to S3
  if (result.success) {
    try {
      await syncToS3({
        workspacePath: input.workspaceId,
        outputDir: '',
        prefix: `jobs/${input.jobId}`,
      });
    } catch {
      // Non-fatal
    }
  }

  return {
    status: result.success ? 'completed' : 'failed',
    output: result.stdout,
  };
}
