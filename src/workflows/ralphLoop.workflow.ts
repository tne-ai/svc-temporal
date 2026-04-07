/**
 * RalphLoopWorkflow — feedback iteration loop.
 *
 * Replaces tne-plugins/plugins/tne/engine/ralph.py.
 *
 * The loop:
 * 1. Invokes a prompt via claude -p or Horizon API
 * 2. Checks the output for the completion promise string
 * 3. On match → exits with status "complete"
 * 4. On no match → increments iteration, re-invokes
 * 5. On max-iterations → exits with status "exhausted"
 *
 * Uses continueAsNew every 5 iterations to bound event history.
 */

import {
  continueAsNew,
  proxyActivities,
  defineQuery,
  setHandler,
} from '@temporalio/workflow';

import type { RalphInput, RalphResult } from '../shared/types.js';
import { CONTINUE_AS_NEW_INTERVAL } from '../shared/constants.js';

import type * as activities from '../activities/index.js';

// Query for loop status
export const getRalphStatusQuery = defineQuery<{
  iteration: number;
  maxIterations: number;
  status: string;
}>('getRalphStatus');

export async function RalphLoopWorkflow(input: RalphInput): Promise<RalphResult> {
  const { invokeSkill } = proxyActivities<typeof activities>({
    startToCloseTimeout: '1h',
    heartbeatTimeout: '60s',
    retry: {
      maximumAttempts: 3,
      initialInterval: '10s',
      backoffCoefficient: 2,
    },
  });

  let iteration = input.resumeIteration || 0;
  let status = 'running';

  setHandler(getRalphStatusQuery, () => ({
    iteration,
    maxIterations: input.maxIterations,
    status,
  }));

  while (iteration < input.maxIterations) {
    iteration++;

    let prompt = input.prompt;
    if (iteration > 1) {
      prompt +=
        `\n\n[Ralph loop: iteration ${iteration}/${input.maxIterations}. ` +
        `Completion promise not yet satisfied. Continue working toward it.]\n` +
        `Completion promise: ${input.completionPromise}`;
    }

    // Invoke via the skill invocation activity
    // We use invokeSkill with a minimal step config
    const result = await invokeSkill(
      {
        number: 0,
        skill: 'ralph-loop',
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
      prompt,
    );

    if (!result.success && !result.stdout) {
      // Retry on empty failure
      continue;
    }

    // Check for completion promise
    if (result.stdout.includes(input.completionPromise)) {
      status = 'complete';
      return {
        status: 'complete',
        iterationsRun: iteration,
        finalOutput: result.stdout,
      };
    }

    // continueAsNew to bound history
    if (iteration % CONTINUE_AS_NEW_INTERVAL === 0) {
      await continueAsNew<typeof RalphLoopWorkflow>({
        ...input,
        resumeIteration: iteration,
      });
    }
  }

  status = 'exhausted';
  return {
    status: 'exhausted',
    iterationsRun: iteration,
    finalOutput: '',
  };
}
