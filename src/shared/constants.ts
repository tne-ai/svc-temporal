/**
 * Shared constants for the Temporal FSM service.
 */

/**
 * Task queue for FSM process orchestration workflows.
 * Env-overridable so an EDGE deployment (svc-temporal sidecar in a per-user pod)
 * polls a per-user queue (e.g. `edge-<user>-fsm`); orion's fsmService reads the
 * same env var to dispatch there. Central leaves it unset → shared queue.
 */
export const FSM_TASK_QUEUE = process.env.FSM_TASK_QUEUE || 'tne-fsm-queue';

/** Task queue for generic long-running Horizon jobs (env-overridable; see above). */
export const JOBS_TASK_QUEUE = process.env.JOBS_TASK_QUEUE || 'tne-jobs-queue';

/**
 * Runtime-only constants (use process.env).
 * These must NOT be imported from workflow code — only from worker.ts, client.ts, and activities.
 */

/** Temporal namespace — only use from worker/client/activities, never workflows */
export const TEMPORAL_NAMESPACE = typeof process !== 'undefined' ? (process.env.TEMPORAL_NAMESPACE || 'tne') : 'tne';

/** Temporal server address — only use from worker/client/activities, never workflows */
export const TEMPORAL_ADDRESS = typeof process !== 'undefined' ? (process.env.TEMPORAL_ADDRESS || 'localhost:7233') : 'localhost:7233';

// ─── Timeouts ───────────────────────────────────────────────────────────────
//
// Policy: long-running orchestration steps (LLM calls, gate cascades, S3
// sync, subprocess invocations) should NEVER fail-permanently due to a
// timeout. Per-attempt timeouts stay generous (single LLM turn shouldn't
// hit a multi-day ceiling), retry policy is unbounded so transient
// infrastructure failures roll into another attempt instead of bubbling
// up. Heartbeat timeouts are the only "fast" timer left — they exist to
// detect *dead* workers (now safe to keep tight because executeStep +
// runGateCascade are wrapped in a wall-clock heartbeat ticker, see
// activities/heartbeatTicker.ts, so a healthy activity can't miss them).

/** Per-attempt timeout for a single step activity (skill invocation + gate
 *  cascade). Generous — a single attempt won't realistically exceed a
 *  week. Retry policy below is unbounded so this isn't a fail-final cap. */
export const STEP_ACTIVITY_TIMEOUT = '7d';

/** Heartbeat timeout for step activities — detects dead workers. Safe to
 *  keep tight because the wall-clock heartbeat ticker fires every 5s
 *  regardless of inner-loop state (see activities/heartbeatTicker.ts). */
export const STEP_HEARTBEAT_TIMEOUT = '5m';

/** Per-attempt timeout for a gate evaluation activity (a single Haiku
 *  LLM call). Long enough to survive provider slowness or a retry storm
 *  upstream; the per-gate retry policy still loops on failures. */
export const GATE_ACTIVITY_TIMEOUT = '30m';

/** Per-attempt timeout for an S3 sync activity. */
export const S3_SYNC_TIMEOUT = '1h';

/** Timeout for waiting on human approval signals (unchanged — a human
 *  signal that takes more than a week is effectively abandoned). */
export const APPROVAL_SIGNAL_TIMEOUT = '7d';

/** Default timeout per skill invocation (claude -p subprocess). Set high
 *  so any reasonable skill turn finishes. */
export const SKILL_INVOCATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Heartbeat interval for long-running subprocess activities */
export const HEARTBEAT_INTERVAL_MS = 5_000; // 5 seconds

// ─── Retry Policies ─────────────────────────────────────────────────────────
//
// Both step and infra retry policies are UNBOUNDED — we never fail a
// workflow because an activity hit a transient infra problem (heartbeat
// timeout, worker rollover, upstream provider 5xx, S3 hiccup, etc.).
// The trade-off is that a permanently broken skill (mis-typed model id,
// schema mismatch the model can't satisfy) will loop forever accruing
// LLM cost — kill such runs via the FE's Cancel button.
//
// Temporal SDK convention for "unbounded" used to be maximumAttempts: 0.
// @temporalio/common ≥ 1.16's compileRetryPolicy validator now throws
// ValueError: "RetryPolicy.maximumAttempts must be a positive integer"
// on 0, hard-failing every activity scheduling and looping the workflow
// task. The current convention is to OMIT the field entirely — the SDK
// then leaves it unset on the proto, which Temporal interprets as
// unlimited retries.
//
// See: https://github.com/temporalio/sdk-typescript/blob/main/packages/common/src/retry-policy.ts

/** Default retry policy for step activities (unbounded). */
export const STEP_RETRY_POLICY = {
  initialInterval: '10s',
  backoffCoefficient: 2,
  maximumInterval: '5m',
} as const;

/** Retry policy for transient infrastructure failures (unbounded). */
export const TRANSIENT_RETRY_POLICY = {
  initialInterval: '5s',
  backoffCoefficient: 2,
  maximumInterval: '2m',
} as const;

// ─── Workflow Limits ────────────────────────────────────────────────────────

/** continueAsNew after this many generator/evaluator iterations to bound event history */
export const CONTINUE_AS_NEW_INTERVAL = 5;

/** Default model for evaluator steps */
export const DEFAULT_EVALUATOR_MODEL = 'claude-haiku-4-5-20251001';

/** Default model for generator steps. Must be an alias the LiteLLM
 *  proxy's model_list recognizes (see orion/litellm/config.template.yaml).
 *  `claude-sonnet-4-20250514` is no longer in the catalog — that was
 *  the source of every "Pi suspected silent failure" the temporal
 *  worker hit on default-model jobs: the proxy 400'd "Invalid model
 *  name" and Pi swallowed the error. */
export const DEFAULT_GENERATOR_MODEL = 'claude-sonnet-4-5-20250929';

/** Default model for preamble/postamble steps */
export const DEFAULT_SUPPORT_MODEL = 'claude-haiku-4-5-20251001';

// ─── Environment Variables ──────────────────────────────────────────────────

/** Horizon API URL for skill invocation (if set, use HTTP POST instead of claude -p) */
export const FSM_INVOKE_URL = typeof process !== 'undefined' ? (process.env.FSM_INVOKE_URL || '') : '';

/** Secret for Horizon API authentication */
export const FSM_INVOKE_SECRET = typeof process !== 'undefined' ? (process.env.FSM_INVOKE_SECRET || '') : '';

/**
 * Base URL for Horizon's /api/fsm-invoke endpoints. Set this once and
 * HORIZON_FSM_START_URL / HORIZON_FSM_EVENTS_URL derive from it. Lets non-HTTP
 * backends (claude-agent-sdk, harness, cli) still emit events back to Horizon
 * without needing FSM_INVOKE_URL set.
 *
 * Resolution order: HORIZON_API_BASE_URL → FSM_INVOKE_URL (stripped of /invoke).
 */
export const HORIZON_FSM_BASE = (() => {
  if (typeof process === 'undefined') return '';
  if (process.env.HORIZON_API_BASE_URL) return process.env.HORIZON_API_BASE_URL.replace(/\/+$/, '');
  const invoke = process.env.FSM_INVOKE_URL || '';
  if (!invoke) return '';
  return invoke.replace(/\/invoke\/?$/, '');
})();

/**
 * Horizon's /api/fsm-invoke/start URL, used by the FSM_START PreToolUse hook so
 * nested fsm-start calls made inside a worker skill register as child FsmRuns in
 * Horizon's DB with parentRunId set.
 */
export const HORIZON_FSM_START_URL = (() => {
  if (typeof process === 'undefined') return '';
  if (process.env.HORIZON_FSM_START_URL) return process.env.HORIZON_FSM_START_URL;
  return HORIZON_FSM_BASE ? `${HORIZON_FSM_BASE}/start` : '';
})();

/**
 * Horizon's /api/fsm-invoke/events URL — where the worker POSTs message /
 * tool_use / file_change / heartbeat events so the App Events tab can render
 * them live. Without this set, every event is silently dropped.
 */
export const HORIZON_FSM_EVENTS_URL = (() => {
  if (typeof process === 'undefined') return '';
  if (process.env.HORIZON_FSM_EVENTS_URL) return process.env.HORIZON_FSM_EVENTS_URL;
  return HORIZON_FSM_BASE ? `${HORIZON_FSM_BASE}/events` : '';
})();

/**
 * Horizon's /api/fsm-invoke/job-events URL — same shared-secret auth as the
 * FSM events endpoint, but keyed by jobId instead of runId. Lets the
 * LongRunningJobWorkflow agent loop emit structured tool_use / tool_result /
 * message / file_change events to the Jobs panel UI.
 */
export const HORIZON_JOB_EVENTS_URL = (() => {
  if (typeof process === 'undefined') return '';
  if (process.env.HORIZON_JOB_EVENTS_URL) return process.env.HORIZON_JOB_EVENTS_URL;
  return HORIZON_FSM_BASE ? `${HORIZON_FSM_BASE}/job-events` : '';
})();

// ─── Agent Backend ─────────────────────────────────────────────────────────

/** Which agent backend to use for skill invocation */
export const AGENT_BACKEND: import('./types.js').AgentBackend =
  (typeof process !== 'undefined' ? process.env.AGENT_BACKEND as any : undefined) || 'harness';

// ─── S3 Workspace ──────────────────────────────────────────────────────────

/** S3 bucket for workspace sync */
export const S3_BUCKET = typeof process !== 'undefined' ? (process.env.AWS_BUCKET || '') : '';

/** AWS region (defaults to us-west-2) */
export const AWS_REGION = typeof process !== 'undefined' ? (process.env.AWS_REGION || 'us-west-2') : 'us-west-2';

/** Per-attempt timeout for workspace sync activities. Bumped from 15m
 *  so a heavy initial pull (multi-GB workspace, slow network) can fit
 *  in a single attempt; retry policy still loops on failure. */
export const WORKSPACE_SYNC_TIMEOUT = '1h';

/** Max concurrent S3 operations during sync */
export const S3_SYNC_CONCURRENCY = 20;

/** Interval for periodic S3 sync during long-running skill invocations */
export const PERIODIC_S3_SYNC_INTERVAL_MS = 30_000; // 30 seconds

/** Files/dirs to exclude from S3 sync */
export const SYNC_EXCLUDE_PATTERNS = [
  'node_modules', '.git', '.venv', '__pycache__', '*.pyc',
  'dist', 'build', '.next', '.cache', 'coverage', '.nyc_output',
  '.DS_Store', 'Thumbs.db', '.vscode', '.idea', '*.log',
  '.env.local', '.env.*.local',
  // Conflict-resolution side paths written back to S3 when S3 was newer than local.
  // Never sync them: they'd pull down into the workspace and get re-scanned/pushed,
  // amplifying every cycle (observed: 4 backup generations per file).
  '*.temporal-*',
  // Agent scaffolding materialized on every invocation — prompts, skill cache,
  // project state, debug output. Syncing these re-uploads thousands of static
  // files per 30s tick and pollutes S3 with ephemeral debugger state.
  '.claude/skills', '.claude/projects', '.claude/EBP', '.claude/debug',
  // Claude CLI + tooling state that has no business in a user-visible bucket.
  // Without these, the user's filespace shows statsig telemetry caches and CLI
  // todo lists alongside their actual work. NOTE: fsm-state-*.json /
  // engine-state-*.json are NOT excluded — they're load-bearing checkpoints
  // (see fsmService.ts:686, fsm-engine.py) that the engine reads to resume
  // after pod restarts; excluding them from S3 sync would break resumption.
  // The frontend file UI hides these by convention instead.
  '.claude/statsig', '.claude/todos', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/test.md',
  '.claude.json', '.claude.json.backup',
  '.local/bin',
  '*.lock', '*.tmp',
];
