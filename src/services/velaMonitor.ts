/**
 * VELA monitor for the central svc-temporal worker.
 *
 * Problem: VELA (the always-on security observability layer) watches chat +
 * edge tool-calls via orion-backend's inline PreToolUse hook, but the central
 * svc-temporal worker ran jobs/FSM steps with NO signal emission — so job
 * tool-calls were invisible to the VELA SOC ("jobs not being watched by vela").
 *
 * This mirrors orion's `emitVelaSignal`/`postVelaEvent`: for every tool call an
 * FSM/job agent makes, POST a raw event to the fleet gateway
 * (`${VELA_COLLECTOR_URL}/signals` = orion-backend `/api/vela`). The gateway
 * re-signs with orion-backend's LICENCED machine id, scores it, and forwards to
 * the CIA server — so we don't need to license this worker's machine or hold
 * the HMAC secret here. Fire-and-forget; never affects tool execution.
 *
 * The deploy already wires the env (VELA_COLLECTOR_URL, and for auth
 * ORION_SERVICE_API_KEY / VELA_DASHBOARD_KEY when the gateway requires it).
 */
const VELA_COLLECTOR_URL = (process.env.VELA_COLLECTOR_URL || '').replace(/\/$/, '');
// central worker → tag its signals so the SOC can distinguish job/FSM activity
// from chat (central-orion) and edge (edge-orion).
const SOURCE = 'central-svc-temporal';

export interface VelaCtx {
  sessionId?: string;
  agentId?: string;
}

/** Fire-and-forget POST of a raw VELA event to the fleet gateway. No-op if the
 *  gateway isn't configured. Never throws. */
function postVelaEvent(event: Record<string, unknown>): void {
  if (!VELA_COLLECTOR_URL) return; // monitor disabled (no gateway on this pod)
  const key = process.env.ORION_SERVICE_API_KEY || process.env.VELA_DASHBOARD_KEY || '';
  try {
    void fetch(`${VELA_COLLECTOR_URL}/signals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: JSON.stringify({
        source: SOURCE,
        agent_name: process.env.HOSTNAME || 'svc-temporal',
        timestamp_utc: new Date().toISOString(),
        ...event,
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      /* best-effort monitor; never affects the job */
    });
  } catch {
    /* never throw from the monitor */
  }
}

/** Emit a tool-call signal (pre_tool) — one per tool the agent runs. */
export function emitVelaToolSignal(
  toolName: string | undefined,
  toolInput: unknown,
  ctx: VelaCtx,
): void {
  if (!toolName || !VELA_COLLECTOR_URL) return;
  let preview = '';
  try {
    preview = JSON.stringify(toolInput ?? {}).slice(0, 800);
  } catch {
    preview = '';
  }
  postVelaEvent({
    vela_event: 'pre_tool',
    tool_name: toolName,
    tool_input: preview.length <= 4000 ? toolInput : undefined,
    payload_preview: preview,
    session_id: ctx.sessionId || '',
    agent_id: ctx.agentId || 'svc-temporal',
  });
}

/** Emit a prompt signal (user_prompt) at the start of a step — parity with
 *  orion's `emitVelaPrompt`, so the scorer catches prompt-layer threats. */
export function emitVelaPrompt(prompt: string | undefined, ctx: VelaCtx): void {
  if (!prompt || typeof prompt !== 'string' || !VELA_COLLECTOR_URL) return;
  postVelaEvent({
    vela_event: 'user_prompt',
    tool_name: 'UserPromptSubmit',
    payload_preview: prompt.slice(0, 400),
    session_id: ctx.sessionId || '',
    agent_id: ctx.agentId || 'svc-temporal',
  });
}
