/**
 * Wall-clock heartbeat helper for long-running activities.
 *
 * Activities that depend on event-driven heartbeats (e.g. emitting heartbeat()
 * from inside an LLM event-stream loop) can die silently when the stream
 * stalls for longer than the configured heartbeatTimeout — cold worker
 * starts, mid-LLM hangs, slow tool execution, or model-side waits can all
 * blow past 60s without an event arriving. The activity is then killed by
 * Temporal even though it's still healthy and would have made progress.
 *
 * Wrap the body with `withWallClockHeartbeat` to install a setInterval that
 * fires `heartbeat()` on a fixed schedule regardless of what the inner code
 * is doing. The ticker is cleared in `finally` so it can't leak across
 * activity attempts.
 */
import { heartbeat } from '@temporalio/activity';
import { HEARTBEAT_INTERVAL_MS } from '../shared/constants.js';

export async function withWallClockHeartbeat<T>(
  details: Record<string, unknown> | (() => Record<string, unknown>),
  fn: () => Promise<T>,
): Promise<T> {
  const interval = setInterval(() => {
    try {
      const payload = typeof details === 'function' ? details() : details;
      heartbeat({ ...payload, ts: Date.now() });
    } catch {
      // heartbeat() throws if the activity context is gone; ignore — the
      // finally block will clean us up.
    }
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}
