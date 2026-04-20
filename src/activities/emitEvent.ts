/**
 * Fire-and-forget event emission to Horizon's /api/fsm-invoke/events endpoint.
 * Gives the UI real-time visibility into what the worker is doing
 * (step transitions, claude messages, tool uses, file changes, gates).
 *
 * URL resolution lives in constants.ts (HORIZON_FSM_EVENTS_URL, derived from
 * HORIZON_API_BASE_URL). If no URL is configured, silently drops events (dev
 * ergonomics — don't crash).
 */

import { HORIZON_FSM_EVENTS_URL, FSM_INVOKE_SECRET } from '../shared/constants.js';

export type FsmEventType =
  | 'step_start' | 'step_complete' | 'step_failed' | 'step_cancelled'
  | 'gate_start' | 'gate_result'
  | 'message' | 'tool_use' | 'tool_result' | 'file_change'
  | 'heartbeat' | 'phase_change' | 'child_run_started'
  | 'token_update';

export async function emitEvent(
  runId: string | undefined,
  type: FsmEventType,
  data: Record<string, any> = {},
): Promise<void> {
  if (!runId || !HORIZON_FSM_EVENTS_URL) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    await fetch(HORIZON_FSM_EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-fsm-secret': FSM_INVOKE_SECRET,
      },
      body: JSON.stringify({ runId, type, data }),
      signal: controller.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    // Fire-and-forget — never block the activity on event emission
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
