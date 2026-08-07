/**
 * Fire-and-forget event emission to Horizon's /api/fsm-invoke/events endpoint.
 * Gives the UI real-time visibility into what the worker is doing
 * (step transitions, claude messages, tool uses, file changes, gates).
 *
 * URL resolution lives in constants.ts (HORIZON_FSM_EVENTS_URL, derived from
 * HORIZON_API_BASE_URL). If no URL is configured, silently drops events (dev
 * ergonomics — don't crash).
 */

import { HORIZON_FSM_EVENTS_URL, HORIZON_JOB_EVENTS_URL, FSM_INVOKE_SECRET } from '../shared/constants.js';

export type FsmEventType =
  | 'step_start' | 'step_complete' | 'step_failed' | 'step_cancelled'
  | 'gate_start' | 'gate_result'
  | 'message' | 'tool_use' | 'tool_result' | 'file_change'
  | 'heartbeat' | 'phase_change' | 'child_run_started'
  | 'token_update';

export type JobEventType =
  | 'message' | 'tool_use' | 'tool_result' | 'file_change'
  | 'token_update' | 'heartbeat';

/**
 * Emission is fire-and-forget so an activity is never blocked on it, but silent
 * is a different thing from non-blocking.
 *
 * Both of these dropped every event without a word: an unset URL returned at
 * the first line, and a failed POST was swallowed by `.catch(() => {})`. The
 * cost of that showed up in orion as benchmark runs with zero tokens and zero
 * spend, indistinguishable from a free model — for months, because nothing
 * anywhere said the events were not being sent.
 *
 * Logged once per process per reason: a per-event log would be thousands of
 * lines, and the fact worth knowing is "these are not arriving", not how many.
 */
const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string, detail?: unknown): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[emitEvent] ${message}`, detail ?? '');
}

export async function emitEvent(
  runId: string | undefined,
  type: FsmEventType,
  data: Record<string, any> = {},
): Promise<void> {
  if (!runId) {
    warnOnce('fsm-norun', 'emitEvent called with no runId — the event is dropped');
    return;
  }
  if (!HORIZON_FSM_EVENTS_URL) {
    warnOnce(
      'fsm-url',
      'HORIZON_FSM_EVENTS_URL is unset — every FSM event is being dropped. ' +
        'Set HORIZON_API_BASE_URL or FSM_INVOKE_URL.',
    );
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(HORIZON_FSM_EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fsm-secret': FSM_INVOKE_SECRET,
      },
      body: JSON.stringify({ runId, type, data }),
      signal: controller.signal,
    }).catch((err) => {
      warnOnce('fsm-post', `POST ${HORIZON_FSM_EVENTS_URL} failed`, err?.message || err);
      return null;
    });
    clearTimeout(timer);
    if (res && !res.ok) {
      warnOnce('fsm-status', `POST ${HORIZON_FSM_EVENTS_URL} returned ${res.status}`);
    }
  } catch (err) {
    // Fire-and-forget — never block the activity on event emission, but say so.
    warnOnce('fsm-throw', 'emitEvent threw', (err as Error)?.message);
  }
}

/** Activity wrapper so the workflow itself can emit events (e.g. step_cancelled
 *  for siblings killed by a failed peer). Workflow code cannot call fetch
 *  directly, so we route through an activity. */
export async function emitFsmEventActivity(params: {
  runId?: string;
  type: FsmEventType;
  data?: Record<string, any>;
}): Promise<void> {
  await emitEvent(params.runId, params.type, params.data || {});
}

/**
 * Per-job parallel of `emitEvent`. Posts to Horizon's job-events endpoint,
 * keyed by jobId. Same shared-secret auth, same fire-and-forget shape — drops
 * silently when no jobId or no URL is configured.
 *
 * Why a separate function: jobs and FSM runs have different identifiers and
 * different ring buffers on the orion side. Conflating them would force orion
 * to disambiguate per-payload and risk leaking events into the wrong stream.
 */
export async function emitJobEvent(
  jobId: string | undefined,
  type: JobEventType,
  data: Record<string, any> = {},
): Promise<void> {
  if (!jobId) {
    // The quietest of the three. A context that lost its jobId drops every
    // event for that job, and the job simply shows no activity — which reads
    // as a model that did nothing rather than a wire that was never connected.
    warnOnce('job-nojob', 'emitJobEvent called with no jobId — the event is dropped');
    return;
  }
  if (!HORIZON_JOB_EVENTS_URL) {
    // This one has a price attached: token_update rides this path, so an unset
    // URL means orion records every job as zero tokens and zero cost, which
    // reads as a free model rather than an unmeasured one.
    warnOnce(
      'job-url',
      'HORIZON_JOB_EVENTS_URL is unset — every job event is being dropped, ' +
        'including token_update, so orion will record no tokens and no cost. ' +
        'Set HORIZON_API_BASE_URL or FSM_INVOKE_URL.',
    );
    return;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(HORIZON_JOB_EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fsm-secret': FSM_INVOKE_SECRET,
      },
      body: JSON.stringify({ jobId, type, data }),
      signal: controller.signal,
    }).catch((err) => {
      warnOnce('job-post', `POST ${HORIZON_JOB_EVENTS_URL} failed`, err?.message || err);
      return null;
    });
    clearTimeout(timer);
    if (res && !res.ok) {
      warnOnce('job-status', `POST ${HORIZON_JOB_EVENTS_URL} returned ${res.status}`);
    }
  } catch (err) {
    // Fire-and-forget — never block the activity on event emission, but say so.
    warnOnce('job-throw', 'emitJobEvent threw', (err as Error)?.message);
  }
}
