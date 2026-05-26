/**
 * yarn submit <workflow> [--flag value ...]
 *
 * Thin ad-hoc submitter for svc-temporal workflows — useful for ops, debug,
 * and parity with the Python engine's `python -m engine <skill>` ergonomics.
 * Connects to the cluster Temporal (TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE
 * env), starts the requested workflow, prints the workflow id, exits.
 *
 * Does NOT follow execution — for live status use:
 *   temporal workflow show -w <workflowId>
 *
 * Supported workflows:
 *   watchdog  — WatchdogWorkflow  (FSM queue)
 *   fsm       — FsmProcessWorkflow (FSM queue)
 *   ralph     — RalphLoopWorkflow  (FSM queue)
 *   job       — LongRunningJobWorkflow (Jobs queue)
 */
import 'dotenv/config';
import { getTemporalClient } from '../client.js';
import { FSM_TASK_QUEUE, JOBS_TASK_QUEUE } from '../shared/constants.js';
import type {
  FsmProcessInput,
  JobInput,
  RalphInput,
  WatchdogInput,
  AgentBackend,
} from '../shared/types.js';
import { parseArgs, requireString, optionalString, boolFlag, optionalNumber } from './args.js';

function usage(code = 2): never {
  console.error(`Usage:
  yarn submit watchdog --skill w-... --user <userId> [--workspace <path>] [--workingDir <subdir>]
                       [--s3Bucket <b>] [--s3Prefix <p>] [--agentBackend <b>] [--dryRun]
  yarn submit fsm      --skill p-... --runId <id> --user <userId> --workspace <path>
                       [--workingDir <subdir>] [--autoApprove] [--s3Bucket <b>] [--s3Prefix <p>]
                       [--agentBackend <b>]
  yarn submit ralph    --scope <s> --prompt <text> --completion <text> [--max <n>] [--model <m>]
  yarn submit job      --jobId <id> --user <userId> --workspaceId <ws> --prompt <text>
                       [--model <m>] [--s3Bucket <b>] [--s3Prefix <p>]

Env: TEMPORAL_ADDRESS (default localhost:7233), TEMPORAL_NAMESPACE (default tne)
`);
  process.exit(code);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd) usage();

  const client = await getTemporalClient();

  switch (cmd) {
    case 'watchdog': {
      const skill = requireString(flags, 'skill');
      const userId = requireString(flags, 'user');
      const input: WatchdogInput = {
        skill,
        userId,
        workspacePath: optionalString(flags, 'workspace'),
        workingDir: optionalString(flags, 'workingDir'),
        s3Bucket: optionalString(flags, 's3Bucket'),
        s3Prefix: optionalString(flags, 's3Prefix'),
        agentBackend: optionalString(flags, 'agentBackend') as AgentBackend | undefined,
        dryRun: boolFlag(flags, 'dryRun'),
      };
      const handle = await client.workflow.start('WatchdogWorkflow', {
        taskQueue: FSM_TASK_QUEUE,
        workflowId: `watchdog-${skill}-${Date.now()}`,
        args: [input],
      });
      console.log(JSON.stringify({ workflowId: handle.workflowId, queue: FSM_TASK_QUEUE }));
      break;
    }
    case 'fsm': {
      const skill = requireString(flags, 'skill');
      const runId = requireString(flags, 'runId');
      const userId = requireString(flags, 'user');
      const workspacePath = requireString(flags, 'workspace');
      const input: FsmProcessInput = {
        runId,
        skillName: skill,
        templateVars: {},
        workspacePath,
        workingDir: optionalString(flags, 'workingDir'),
        userId,
        autoApprove: boolFlag(flags, 'autoApprove'),
        s3Bucket: optionalString(flags, 's3Bucket'),
        s3Prefix: optionalString(flags, 's3Prefix'),
        agentBackend: optionalString(flags, 'agentBackend') as AgentBackend | undefined,
      };
      const handle = await client.workflow.start('FsmProcessWorkflow', {
        taskQueue: FSM_TASK_QUEUE,
        workflowId: `fsm-${runId}`,
        args: [input],
      });
      console.log(JSON.stringify({ workflowId: handle.workflowId, queue: FSM_TASK_QUEUE }));
      break;
    }
    case 'ralph': {
      const scope = requireString(flags, 'scope');
      const prompt = requireString(flags, 'prompt');
      const completion = requireString(flags, 'completion');
      const input: RalphInput = {
        scope,
        prompt,
        completionPromise: completion,
        maxIterations: optionalNumber(flags, 'max') ?? 10,
        model: optionalString(flags, 'model'),
      };
      const handle = await client.workflow.start('RalphLoopWorkflow', {
        taskQueue: FSM_TASK_QUEUE,
        workflowId: `ralph-${scope}-${Date.now()}`,
        args: [input],
      });
      console.log(JSON.stringify({ workflowId: handle.workflowId, queue: FSM_TASK_QUEUE }));
      break;
    }
    case 'job': {
      const jobId = requireString(flags, 'jobId');
      const userId = requireString(flags, 'user');
      const workspaceId = requireString(flags, 'workspaceId');
      const prompt = requireString(flags, 'prompt');
      const input: JobInput = {
        jobId,
        userId,
        workspaceId,
        prompt,
        model: optionalString(flags, 'model'),
        s3Bucket: optionalString(flags, 's3Bucket'),
        s3Prefix: optionalString(flags, 's3Prefix'),
      };
      const handle = await client.workflow.start('LongRunningJobWorkflow', {
        taskQueue: JOBS_TASK_QUEUE,
        workflowId: `job-${jobId}`,
        args: [input],
      });
      console.log(JSON.stringify({ workflowId: handle.workflowId, queue: JOBS_TASK_QUEUE }));
      break;
    }
    default:
      console.error(`Unknown workflow: ${cmd}`);
      usage();
  }
}

main()
  .catch((err) => {
    console.error('submit failed:', err?.message || err);
    process.exit(1);
  })
  .finally(async () => {
    // Don't await; the client connection may be reused if the CLI is
    // imported as a library. Process exits cleanly after main() resolves
    // because Temporal's connection holds no event-loop refs after the
    // start() call returns.
  });
