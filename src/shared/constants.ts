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

/** Files/dirs to exclude from S3 sync */
export const SYNC_EXCLUDE_PATTERNS = [
  'node_modules', '.git', '.venv', '__pycache__', '*.pyc',
  'dist', 'build', '.next', '.cache', 'coverage', '.nyc_output',
  '.DS_Store', 'Thumbs.db', '.vscode', '.idea', '*.log',
  '.env.local', '.env.*.local',
];
