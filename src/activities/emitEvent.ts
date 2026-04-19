/**
 * Fire-and-forget event emission to Horizon's /api/fsm-invoke/events endpoint.
 * Gives the UI real-time visibility into what the worker is doing
 * (step transitions, claude messages, tool uses, file changes, gates).
 *
 * URL resolution lives in constants.ts (HORIZON_FSM_EVENTS_URL) so all backends
 * can emit events even when FSM_INVOKE_URL is unset (e.g. harness, sdk, cli).
 * If no URL is configured, silently drops events (dev ergonomics — don't crash).
 */

import { HORIZON_FSM_EVENTS_URL, FSM_INVOKE_SECRET } from '../shared/constants.js';

export type FsmEventType =
  | 'step_start' | 'step_complete' | 'step_failed'
  | 'gate_start' | 'gate_result'
  | 'message' | 'tool_use' | 'tool_result' | 'file_change'
  | 'heartbeat' | 'phase_change' | 'child_run_started';

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
