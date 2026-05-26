/**
 * yarn schedule <action> ...
 *
 * Manages Temporal Schedules for periodic workflows. Today the only
 * scheduled workflow is WatchdogWorkflow; extend as needed.
 *
 * Actions:
 *   create watchdog --skill w-... --user <u> --interval <duration>
 *                   [--id <schedule-id>] [--workspace <p>] [--workingDir <d>]
 *                   [--s3Bucket <b>] [--s3Prefix <p>] [--agentBackend <b>]
 *   delete <schedule-id>
 *   list
 *
 * Duration format: Temporal Go-style — "1d", "12h", "30m", "1h30m", ...
 *
 * Env: TEMPORAL_ADDRESS (default localhost:7233), TEMPORAL_NAMESPACE (default tne)
 */
import 'dotenv/config';
import type { Duration } from '@temporalio/common';
import { getTemporalClient } from '../client.js';
import { FSM_TASK_QUEUE } from '../shared/constants.js';
import type { WatchdogInput, AgentBackend } from '../shared/types.js';
import { parseArgs, requireString, optionalString, boolFlag } from './args.js';

function usage(code = 2): never {
  console.error(`Usage:
  yarn schedule create watchdog --skill w-... --user <u> --interval <duration> [--id <schedule-id>]
                                [--workspace <p>] [--workingDir <d>] [--s3Bucket <b>] [--s3Prefix <p>]
                                [--agentBackend <b>] [--dryRun]
  yarn schedule delete <schedule-id>
  yarn schedule list
`);
  process.exit(code);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const action = positional[0];
  if (!action) usage();

  const client = await getTemporalClient();

  switch (action) {
    case 'create': {
      const kind = positional[1];
      if (kind !== 'watchdog') {
        console.error(`Only "watchdog" is a schedulable workflow type today.`);
        usage();
      }
      const skill = requireString(flags, 'skill');
      const userId = requireString(flags, 'user');
      const interval = requireString(flags, 'interval');
      const scheduleId = optionalString(flags, 'id') ?? `watchdog-${skill}`;
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
      await client.schedule.create({
        scheduleId,
        // Temporal accepts Go-style durations ("1d", "12h", "30m"); the
        // TS type alias is a templated literal so we cast a runtime
        // string through it. Validation happens server-side.
        spec: { intervals: [{ every: interval as Duration }] },
        action: {
          type: 'startWorkflow',
          workflowType: 'WatchdogWorkflow',
          taskQueue: FSM_TASK_QUEUE,
          args: [input],
        },
      });
      console.log(JSON.stringify({ scheduleId, every: interval, skill }));
      break;
    }
    case 'delete': {
      const id = positional[1];
      if (!id) {
        console.error('schedule delete requires <schedule-id>');
        usage();
      }
      await client.schedule.getHandle(id).delete();
      console.log(JSON.stringify({ deleted: id }));
      break;
    }
    case 'list': {
      const out: any[] = [];
      for await (const s of client.schedule.list()) {
        out.push({
          scheduleId: s.scheduleId,
          workflowType: (s as any).action?.workflowType,
          note: (s as any).note,
        });
      }
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    default:
      console.error(`Unknown action: ${action}`);
      usage();
  }
}

main().catch((err) => {
  console.error('schedule failed:', err?.message || err);
  process.exit(1);
});
