/**
 * Shared constants for the Temporal FSM service.
 */

/** Task queue for FSM process orchestration workflows */
export const FSM_TASK_QUEUE = 'tne-fsm-queue';

/** Task queue for generic long-running Horizon jobs */
export const JOBS_TASK_QUEUE = 'tne-jobs-queue';

/** Temporal namespace */
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'tne';

/** Temporal server address */
export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

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
export const DEFAULT_EVALUATOR_MODEL = 'claude-haiku-4-5';

/** Default model for generator steps */
export const DEFAULT_GENERATOR_MODEL = 'claude-sonnet-4-6';

/** Default model for preamble/postamble steps */
export const DEFAULT_SUPPORT_MODEL = 'claude-haiku-4-5';

// ─── Environment Variables ──────────────────────────────────────────────────

/** Horizon API URL for skill invocation (if set, use HTTP POST instead of claude -p) */
export const FSM_INVOKE_URL = process.env.FSM_INVOKE_URL || '';

/** Secret for Horizon API authentication */
export const FSM_INVOKE_SECRET = process.env.FSM_INVOKE_SECRET || '';
