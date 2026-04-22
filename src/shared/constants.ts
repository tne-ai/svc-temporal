/**
 * Shared constants for the Temporal FSM service.
 */

/** Task queue for FSM process orchestration workflows */
export const FSM_TASK_QUEUE = 'tne-fsm-queue';

/** Task queue for generic long-running Horizon jobs */
export const JOBS_TASK_QUEUE = 'tne-jobs-queue';

/**
 * Runtime-only constants (use process.env).
 * These must NOT be imported from workflow code — only from worker.ts, client.ts, and activities.
 */

/** Temporal namespace — only use from worker/client/activities, never workflows */
export const TEMPORAL_NAMESPACE = typeof process !== 'undefined' ? (process.env.TEMPORAL_NAMESPACE || 'tne') : 'tne';

/** Temporal server address — only use from worker/client/activities, never workflows */
export const TEMPORAL_ADDRESS = typeof process !== 'undefined' ? (process.env.TEMPORAL_ADDRESS || 'localhost:7233') : 'localhost:7233';

// ─── Timeouts ───────────────────────────────────────────────────────────────

/** Default timeout for a single step activity (skill invocation + gate cascade) */
export const STEP_ACTIVITY_TIMEOUT = '4h';

/** Heartbeat timeout for step activities — detects stuck processes */
export const STEP_HEARTBEAT_TIMEOUT = '60s';

/** Timeout for gate evaluation activities (LLM calls) */
export const GATE_ACTIVITY_TIMEOUT = '5m';

/** Timeout for S3 sync activities */
export const S3_SYNC_TIMEOUT = '10m';

/** Timeout for waiting on human approval signals */
export const APPROVAL_SIGNAL_TIMEOUT = '7d';

/** Default timeout per skill invocation (claude -p subprocess) */
export const SKILL_INVOCATION_TIMEOUT_MS = 3_600_000; // 60 minutes

/** Heartbeat interval for long-running subprocess activities */
export const HEARTBEAT_INTERVAL_MS = 5_000; // 5 seconds

// ─── Retry Policies ─────────────────────────────────────────────────────────

/** Default retry policy for step activities */
export const STEP_RETRY_POLICY = {
  maximumAttempts: 3,
  initialInterval: '10s',
  backoffCoefficient: 2,
  maximumInterval: '5m',
} as const;

/** Retry policy for transient infrastructure failures */
export const TRANSIENT_RETRY_POLICY = {
  maximumAttempts: 5,
  initialInterval: '5s',
  backoffCoefficient: 2,
  maximumInterval: '2m',
} as const;

// ─── Workflow Limits ────────────────────────────────────────────────────────

/** continueAsNew after this many generator/evaluator iterations to bound event history */
export const CONTINUE_AS_NEW_INTERVAL = 5;

/** Default model for evaluator steps */
export const DEFAULT_EVALUATOR_MODEL = 'claude-haiku-4-5-20251001';

/** Default model for generator steps */
export const DEFAULT_GENERATOR_MODEL = 'claude-sonnet-4-20250514';

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
const HORIZON_FSM_BASE = (() => {
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

// ─── Agent Backend ─────────────────────────────────────────────────────────

/** Which agent backend to use for skill invocation */
export const AGENT_BACKEND: import('./types.js').AgentBackend =
  (typeof process !== 'undefined' ? process.env.AGENT_BACKEND as any : undefined) || 'harness';

// ─── S3 Workspace ──────────────────────────────────────────────────────────

/** S3 bucket for workspace sync */
export const S3_BUCKET = typeof process !== 'undefined' ? (process.env.AWS_BUCKET || '') : '';

/** AWS region (defaults to us-west-2) */
export const AWS_REGION = typeof process !== 'undefined' ? (process.env.AWS_REGION || 'us-west-2') : 'us-west-2';

/** Timeout for workspace sync activities */
export const WORKSPACE_SYNC_TIMEOUT = '15m';

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
  '*.lock', '*.tmp',
];
