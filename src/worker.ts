/**
 * Temporal worker entry point.
 *
 * Registers workflows and activities, connects to the Temporal server,
 * and starts polling for tasks on the configured task queues.
 */

// Load .env BEFORE any other import so module-level captures in
// ./shared/constants.js (HORIZON_FSM_EVENTS_URL, FSM_INVOKE_SECRET, etc) see
// the values. Under ESM all imports evaluate before top-level code runs, so a
// later `config()` call is too late — constants are already frozen to ''.
import 'dotenv/config';

// Remove AWS_PROFILE before any imports touch the AWS SDK credential chain.
// When both AWS_PROFILE and static credentials (from eval) are present,
// the SDK warns and picks the profile path — which can resolve stale creds.
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_PROFILE) {
  delete process.env.AWS_PROFILE;
}

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
    maxConcurrentActivityTaskExecutions: 25,
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

  // Graceful shutdown on K8s SIGTERM. Without this the process dies
  // abruptly when the pod is rolled and any in-flight activities are
  // orphaned — they keep running on the dying pod for a few seconds then
  // get killed, and Temporal only learns about it via the next heartbeat
  // timeout (60s+ later). `worker.shutdown()` stops polling new tasks
  // and resolves the run() promise after `shutdownGraceTime` (default
  // ~5s) so in-flight activities have a window to complete cleanly. Pair
  // with terminationGracePeriodSeconds: 300 on the Deployment so K8s
  // doesn't SIGKILL us before drain completes.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, draining workers…`);
    try { fsmWorker.shutdown(); } catch (e) { console.error('fsmWorker.shutdown failed', e); }
    try { jobsWorker.shutdown(); } catch (e) { console.error('jobsWorker.shutdown failed', e); }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Run both workers concurrently
  await Promise.all([
    fsmWorker.run(),
    jobsWorker.run(),
  ]);
  console.log('Workers drained, exiting.');
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
