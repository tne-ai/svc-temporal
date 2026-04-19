/**
 * Temporal worker entry point.
 *
 * Registers workflows and activities, connects to the Temporal server,
 * and starts polling for tasks on the configured task queues.
 */

// Remove AWS_PROFILE before any imports touch the AWS SDK credential chain.
// When both AWS_PROFILE and static credentials (from eval) are present,
// the SDK warns and picks the profile path — which can resolve stale creds.
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_PROFILE) {
  delete process.env.AWS_PROFILE;
}

import { config } from 'dotenv';
config();

import { Worker, NativeConnection } from '@temporalio/worker';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, FSM_TASK_QUEUE, JOBS_TASK_QUEUE } from './shared/constants.js';

import * as activities from './activities/index.js';

async function run() {
  console.log(`Connecting to Temporal at ${TEMPORAL_ADDRESS} (namespace: ${TEMPORAL_NAMESPACE})`);

  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });

  // FSM worker — handles FsmProcessWorkflow and RalphLoopWorkflow
  const fsmWorker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: FSM_TASK_QUEUE,
    workflowsPath: new URL('./workflows/index.js', import.meta.url).pathname,
    activities,
    maxConcurrentActivityTaskExecutions: 4,
    maxConcurrentWorkflowTaskExecutions: 10,
  });

  // Jobs worker — handles LongRunningJobWorkflow
  const jobsWorker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: JOBS_TASK_QUEUE,
    workflowsPath: new URL('./workflows/index.js', import.meta.url).pathname,
    activities,
    maxConcurrentActivityTaskExecutions: 2,
    maxConcurrentWorkflowTaskExecutions: 5,
  });

  console.log(`Workers started on queues: ${FSM_TASK_QUEUE}, ${JOBS_TASK_QUEUE}`);

  // Run both workers concurrently
  await Promise.all([
    fsmWorker.run(),
    jobsWorker.run(),
  ]);
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
