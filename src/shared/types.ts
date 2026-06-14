/**
 * Shared types for the Temporal FSM service.
 *
 * These mirror the Python engine's schema.py dataclasses, ported to TypeScript
 * for use in Temporal workflows and activities.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export enum Phase {
  INIT = 'init',
  PREAMBLE = 'preamble',
  APPROVAL_GATE = 'approval_gate',
  GENERATOR = 'generator',
  EVALUATOR = 'evaluator',
  POSTAMBLE = 'postamble',
  FINALIZATION = 'finalization',
  COMPLETE = 'complete',
}

export enum StepStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETE = 'COMPLETE',
  AWAITING_REVIEW = 'AWAITING_REVIEW',
  STALE = 'STALE',
  FAILED = 'FAILED',
}

export enum EvaluatorMode {
  FAIL_FAST = 'fail-fast',
  ALL_MUST_PASS = 'all-must-pass',
  PARALLEL_THRESHOLD = 'parallel-threshold',
  SEQUENTIAL_ONLY = 'sequential-only',
  EXPERT_COUNCIL = 'expert-council',
}

export enum StageType {
  FACT_SEARCH = 'fact_search',
  ANALYSIS = 'analysis',
  CODE = 'code',
  CREATIVE = 'creative',
  DEFAULT = 'default',
}

// ─── Config Types (parsed from SKILL.md) ────────────────────────────────────

export interface FailFastConfig {
  maxRetries: number;
  gates: number[];
  persona?: Record<string, unknown>;
  counselPersonas?: Record<string, unknown>;
}

export interface Step {
  /**
   * Step identifier from the SOP table's first column. Kept as a string so
   * skills can use labels like `"0a"` / `"3b"` in addition to plain integers.
   */
  number: string;
  skill: string;
  inputs: string[];
  output: string;
  verify: string;
  run: string;
  notes: string;
  passCondition: string;
  stageType: StageType;
  dependsOn: string[];
  backpropSkill: string;
  failFast: FailFastConfig;
  permissionMode: string;
  model: string;
  /** Per-step Temporal activity timeout in seconds. 0 = use the worker's
   *  DEFAULT_STEP_TIMEOUT. Parity with engine.schema.Step.timeout
   *  (tne-plugins #2060). Currently parsed but not enforced — the
   *  TS FsmProcessWorkflow still uses its global default for every
   *  step. A follow-up will thread this into the activity options. */
  timeout: number;
  /** When true, the leaf is dispatched as a separate child workflow with
   *  bounded iterations. Parity with engine.schema.Step.tne_engine
   *  (tne-plugins #2060). Parsed from the leaf SKILL.md's `tne-engine:`
   *  top-level frontmatter key. Currently parsed but not enforced —
   *  see FsmProcessWorkflow follow-up. */
  tneEngine: boolean;
  /** Max iterations for the leaf child workflow when `tneEngine` is set.
   *  Parity with engine.schema.Step.tne_engine_max_iterations. */
  tneEngineMaxIterations: number;
}

export interface FinalizationEntry {
  versionedFile: string;
  finalFile: string;
  strip: string;
}

export interface ExpertConfig {
  source: string;
  name: string;
  domain: string;
  experience: string;
  philosophy: string;
  criteria: string;
}

export interface CouncilMember {
  number: number;
  source: string;
  name: string;
  domain: string;
  focus: string;
  criteria: string;
}

export interface ProcessConfig {
  scope: string;
  maxIterations: number;
  evaluatorMode: EvaluatorMode;
  completionThreshold: string;
  parentScope: string;
  approvalGate: boolean;
  userCheckpoint: boolean;
  stageReview: boolean;
  /** Pause after each subagent step so a human can review before the
   *  next step runs. Defaults to true. Parity with
   *  engine.schema.ProcessConfig.per_step_review (tne-plugins #1975).
   *  Parsed but not yet enforced — currently every step runs to
   *  completion regardless. */
  perStepReview: boolean;
  preFlightInputs: string[];
  inputsFile: string;
  inputsBackprop: boolean;
  inputsBackpropGate: string;
  /** Run generator phase steps in parallel (DAG-resolved by `dependsOn`).
   *  Postamble always uses the parallel runner; preamble/evaluator stay
   *  sequential. */
  parallelGenerator: boolean;

  preamble: Step[];
  generator: Step[];
  evaluator: Step[];
  postamble: Step[];
  finalization: FinalizationEntry[];

  expert?: ExpertConfig;
  council: CouncilMember[];

  /** `sop: vars:` — skill-level variable defaults from frontmatter.
   *  Parity with engine.schema.ProcessConfig.vars (tne-plugins #2018).
   *  Resolved between CLI overrides and the inputs file in the
   *  template_vars precedence chain:
   *      cli > inputs_file > vars > builtins
   *  Currently parsed but not yet wired into the template_vars
   *  resolution path — follow-up will plumb it through invokeSkill. */
  vars: Record<string, string>;
}

// ─── Workflow Input/Output Types ────────────────────────────────────────────

export interface FsmProcessInput {
  /** Unique run identifier (maps to ProcessRun.id in Horizon) */
  runId: string;
  /** Skill name to resolve and parse (e.g., "p-ceo1-strategy") */
  skillName?: string;
  /** Parsed process config from SKILL.md — if omitted, resolved via skillName */
  config?: ProcessConfig;
  /** Template variables resolved from inputs file */
  templateVars: Record<string, string>;
  /** Path to the workspace root on the worker filesystem. S3 pull/push target
   *  this directory (scoped by `workingDir` when set). */
  workspacePath: string;
  /** Relative subdirectory inside `workspacePath` that the agent's cwd lands
   *  in. S3 pull/push are scoped to this subtree so sibling subdirs stay
   *  untouched. Empty/undefined → cwd is the workspace root. */
  workingDir?: string;
  /** User ID for audit tracking */
  userId: string;
  /** Whether to auto-approve all review gates */
  autoApprove: boolean;
  /** Resumed state from continueAsNew */
  resumeState?: FsmWorkflowState;
  /** S3 bucket for workspace sync */
  s3Bucket?: string;
  /** S3 key prefix (usually userId) */
  s3Prefix?: string;
  /** Agent backend override — if unset, falls back to AGENT_BACKEND env var */
  agentBackend?: AgentBackend;
  /** Per-user delegate (worker) model override. When set, every step in
   *  this run runs on this model regardless of the model the SKILL.md
   *  specified. Lets the user say "all my workers run on X" without
   *  having to edit per-skill defaults. Null/undefined → use step.model. */
  delegateModel?: string;
  /** Per-user delegate provider override (anthropic / openrouter). The
   *  backend selection is decided by Horizon and surfaced via
   *  `agentBackend`; this field is informational + future-proofing. */
  delegateProvider?: string;
  /** Optional cap on the generator↔evaluator iteration count. Acts as a
   *  ceiling against `config.maxIterations` (never raises it). Set to 1
   *  for one-shot semantics (watchdogs); leave undefined to honor the
   *  skill's own cap. */
  maxIterations?: number;
  /** Per-run tool harness — picks who runs the agent loop. Mirrors orion's
   *  `User.toolHarness` resolved into a concrete choice:
   *    `'claude_sdk'` — invokeSkill uses the Claude Agent SDK
   *    `'pi'`         — invokeSkill uses the Pi (in-process) harness
   *  LiteLLM is always-on as the model transport regardless of this value;
   *  the proxy translates per-model upstream. Undefined falls back to the
   *  per-deploy AGENT_BACKEND env-var default for compatibility with the
   *  pre-toolHarness migration. */
  toolHarness?: 'pi' | 'claude_sdk';
  /** User-scoped GitHub token fetched by Orion from the user's synced GitHub
   *  connection. Forwarded to activities as GH_TOKEN/GITHUB_TOKEN for gh CLI
   *  and git operations; never persisted by svc-temporal. */
  githubToken?: string;
}

export interface FsmProcessResult {
  status: 'completed' | 'failed' | 'cancelled';
  state: FsmWorkflowState;
}

export interface FsmWorkflowState {
  phase: Phase;
  iteration: number;
  steps: Record<string, StepState>;
  iterations: IterationRecord[];
  earlyExit: boolean;
}

export interface StepState {
  status: StepStatus;
  outputPath?: string;
  feedback?: string;
  humanNotes?: string;
  error?: string;
  gateResults?: Record<number, string>;
  retries: number;
  startedAt?: string;
  completedAt?: string;
  /** Mtime (Unix epoch ms) of `outputPath` recorded at step-complete time.
   *  Used by `checkFreshness` on resume to detect external edits and by
   *  `propagateForward` after a backprop event. Mirrors the Python engine's
   *  `state.steps[key]["output_mtime"]` field. */
  outputMtime?: number;
  /** Mtimes of every file declared in `step.inputs`, captured when the step
   *  ran. On resume the freshness check compares these against current
   *  mtimes to spot inputs that changed since this step last completed. */
  inputMtimes?: Record<string, number>;
}

export interface IterationRecord {
  iteration: number;
  result: 'PASS' | 'FAIL';
  stoppingEvaluator?: string;
  keyIssues: string;
  timestamp?: string;
}

// ─── Activity Input/Output Types ────────────────────────────────────────────

export interface StepExecutionParams {
  step: Step;
  iteration: number;
  templateVars: Record<string, string>;
  feedback?: string;
  humanNotes?: string;
  /** Which FSM phase owns this step. Included in step_start/step_complete
   *  events so the UI can group siblings and render parallel lanes. */
  phase?: 'preamble' | 'generator' | 'evaluator' | 'postamble';
  /** True when this step is running as part of a parallel wave. */
  parallel?: boolean;
  /** Wave index within the phase — all siblings in the same BFS level share a
   *  waveIdx so the UI can cluster them regardless of actual start-time skew
   *  (worker concurrency may serialize activities that are logically parallel). */
  waveIdx?: number;
  /** Workspace root directory (same semantics as `FsmProcessInput.workspacePath`). */
  workspacePath: string;
  /** Relative subdir under `workspacePath` — scopes S3 sync and the agent's cwd. */
  workingDir?: string;
  manifestPath?: string;
  /** Pre-computed manifest body (markdown) listing prior completed step
   *  outputs. Embedded inline in the agent prompt as "## Available Inputs"
   *  so the agent has context from earlier phases without a separate file
   *  read. Empty string means no prior context is available yet. */
  manifestContent?: string;
  /** Parsed SOP config — forwarded to the activity so the executeStep
   *  activity can compute manifests locally when not pre-computed. */
  config?: ProcessConfig;
  /** Current workflow state snapshot — same purpose as `config`. */
  state?: FsmWorkflowState;
  /** Phase-scoped step key `${phase}.${step.number}` — used by manifest
   *  generation to know which step is "current" (excluded from manifest). */
  currentStepKey?: string;
  agentBackend?: AgentBackend;
  /** Mirrors `FsmProcessInput.toolHarness` — threaded through so the
   *  per-step executeStep activity can forward it to invokeSkill, which
   *  picks Claude SDK vs Pi orchestration. */
  toolHarness?: 'pi' | 'claude_sdk';
  /** User-scoped GitHub token from the synced Orion GitHub connection. */
  githubToken?: string;
  /** Parent FSM run id — passed to the agent so nested fsm-start calls link back. */
  parentRunId?: string;
  /** User id — forwarded to horizon's /api/fsm-invoke/start for nested FSM runs. */
  userId?: string;
  /** S3 bucket for periodic workspace sync during long-running skill invocations. */
  s3Bucket?: string;
  /** S3 key prefix (usually userId) for periodic workspace sync. */
  s3Prefix?: string;
}

export interface StepResult {
  success: boolean;
  outputPath?: string;
  feedback?: string;
  error?: string;
  gateResults?: Record<number, string>;
  /** Mtime (Unix epoch ms) of the file at `outputPath`, captured by the
   *  activity right after gate cascade passes. The workflow stores it on
   *  the step's StepState so a later `checkFreshness` pass can detect
   *  external edits across runs. */
  outputMtime?: number;
  /** Mtimes of the files referenced by `step.inputs` at the moment the
   *  step ran. */
  inputMtimes?: Record<string, number>;
}

// ─── Freshness Check (backprop on resume) ──────────────────────────────────

export interface FreshnessCheckParams {
  /** Workflow runId — forwarded for log correlation. */
  runId: string;
  /** Workspace root the step executed against (same semantics as
   *  `FsmProcessInput.workspacePath`). */
  workspacePath: string;
  /** Optional working subdir — input/output paths are resolved against
   *  `join(workspacePath, workingDir)`. */
  workingDir?: string;
  /** Snapshot of every step's recorded mtimes. Keyed by step key
   *  (e.g. `"preamble.1"`). */
  recorded: Record<string, { outputPath?: string; outputMtime?: number; inputMtimes?: Record<string, number> }>;
}

export interface FreshnessCheckResult {
  /** Step keys whose output was edited externally since the last recorded
   *  mtime. Per the Python engine's conservative model these mark the
   *  step itself stale; the workflow's `propagateForward` then cascades
   *  to dependents. */
  externallyModified: string[];
  /** Step keys whose declared inputs are newer than the step's recorded
   *  output — the step needs to re-run. */
  inputsNewer: string[];
}

export interface InvocationResult {
  success: boolean;
  stdout: string;
  stderr: string;
  outputPath?: string;
  exitCode: number;
  stageReviewPause?: boolean;
  /**
   * Constrained-decoded JSON produced via Anthropic Structured Outputs,
   * present when the leaf skill declared `output_schema_path` in its
   * frontmatter. The caller (executeStep) writes this to the step's
   * output file as JSON, guaranteeing zero structural drift.
   */
  structuredOutput?: unknown;
}

export interface GateResult {
  gateNumber: number;
  passed: boolean;
  feedback: string;
  score?: number;
  error?: string;
}

export interface CascadeResult {
  passed: boolean;
  gateResults: GateResult[];
  finalFeedback: string;
  /** True when one of the gates couldn't reach its evaluator (harness init
   *  failed, model unreachable, etc.) rather than judging the content
   *  unfavorably. executeStep uses this to skip retries — retrying won't
   *  fix infrastructure. */
  infrastructureError?: boolean;
}

// ─── Ralph Loop Types ───────────────────────────────────────────────────────

export interface RalphInput {
  scope: string;
  prompt: string;
  completionPromise: string;
  maxIterations: number;
  model?: string;
  resumeIteration?: number;
}

export interface RalphResult {
  status: 'complete' | 'exhausted' | 'failed';
  iterationsRun: number;
  finalOutput: string;
}

// ─── Long-Running Job Types ─────────────────────────────────────────────────

export interface JobInput {
  jobId: string;
  prompt: string;
  userId: string;
  workspaceId: string;
  tools?: string[];
  model?: string;
  /** S3 bucket for workspace sync */
  s3Bucket?: string;
  /** S3 key prefix (usually userId) */
  s3Prefix?: string;
  /** Output folder within workspace (e.g., "jobs/my-job") */
  outputFolder?: string;
  /** Agent backend override — if unset, falls back to AGENT_BACKEND env var */
  agentBackend?: AgentBackend;
  /** Skill name to run via the FSM engine. When set with `processRunId`,
   *  the workflow dispatches to FsmProcessWorkflow as a child on the
   *  tne-fsm-queue instead of running the generic agent-task path. */
  skillName?: string;
  /** Relative subdirectory inside the user workspace; forwarded to FSM. */
  workingDir?: string;
  /** Pre-created ProcessRun.id in Horizon — reused as the FSM child runId. */
  processRunId?: string;
  /** Absolute workspace path on the worker — overrides the default
   *  `/tmp/temporal-jobs/${jobId}` for FSM dispatch. */
  workspacePath?: string;
  /** When true, FSM approval gates and stage reviews auto-approve so
   *  headless / M2M callers aren't parked forever waiting for a human
   *  approval signal. Ignored outside the FSM dispatch path. */
  autoApprove?: boolean;
  /** Same semantics as `FsmProcessInput.toolHarness` — picks who runs the
   *  agent loop (Pi vs Claude SDK). LiteLLM is always-on as transport. */
  toolHarness?: 'pi' | 'claude_sdk';
  /** Completion mode: run the job as a SINGLE model call — no tools, one
   *  turn, no S3 workspace — instead of the agent loop. For single-shot
   *  "prompt → answer/JSON" jobs (e.g. compass-helm's analyzer/briefing/
   *  relevance). `skillName` (when set) still loads the leaf output schema
   *  for Structured Outputs on the claude_sdk backend. Durable via Temporal
   *  like any other job; the difference is purely the executor. */
  completionMode?: boolean;
  /** Short-lived/per-user GitHub token fetched by Orion from the user's synced
   *  GitHub connection and passed to the worker for this job only. svc-temporal
   *  maps it to GH_TOKEN/GITHUB_TOKEN for gh CLI + HTTPS git operations. */
  githubToken?: string;
}

export interface JobResult {
  status: 'completed' | 'failed';
  output: string;
  outputFiles?: string[];
}

// ─── Watchdog Types ─────────────────────────────────────────────────────────

/**
 * Input for WatchdogWorkflow — a thin wrapper that runs a single w-* skill
 * unattended on a Temporal schedule. Mirrors tne-plugins' WatchdogWorkflow
 * (engine/temporal_workflow.py) so a w-* skill defined for one engine runs
 * identically here.
 */
export interface WatchdogInput {
  /** Name of the w-* skill to run (e.g. "w-cai-ethos4-watch-rules"). */
  skill: string;
  /** User id for audit / S3-scope; mirrors FsmProcessInput.userId. */
  userId: string;
  /** Optional workspace root. Defaults to /tmp/temporal-watchdog/<runId>. */
  workspacePath?: string;
  /** Optional working subdir (forwarded to the child FSM). */
  workingDir?: string;
  /** Optional S3 bucket / prefix for workspace sync. */
  s3Bucket?: string;
  s3Prefix?: string;
  /** Agent backend override (forwarded to the child FSM). */
  agentBackend?: AgentBackend;
  /** Parse + validate but skip side-effects (forwarded as templateVar). */
  dryRun?: boolean;
}

export interface WatchdogResult {
  skill: string;
  status: 'completed' | 'failed' | 'cancelled';
  state: FsmWorkflowState;
}

// ─── Signal Payloads ────────────────────────────────────────────────────────

export interface ApprovalSignalPayload {
  approved: boolean;
  notes?: string;
}

// ─── S3 Workspace Types ───────────────────────────────────────────────────

export interface WorkspaceSyncParams {
  /** S3 bucket name */
  bucket: string;
  /** S3 key prefix — typically the userId (all user files live under this) */
  prefix: string;
  /** Local directory to sync to/from */
  localPath: string;
  /** Optional subdirectory within the workspace to scope the sync */
  scopePath?: string;
}

export interface WorkspaceSyncResult {
  /** Number of files downloaded or uploaded */
  fileCount: number;
  /** Files that had conflicts (S3 version differs from local) */
  conflicts: FileConflict[];
  /** Total bytes transferred */
  bytes: number;
}

export interface FileConflict {
  /** Relative path within workspace */
  path: string;
  /** What happened */
  resolution: 'skipped' | 'overwritten' | 'renamed';
  /** If renamed, the new path */
  renamedTo?: string;
  /** ETag of the S3 version */
  s3ETag?: string;
  /** Last modified time of local version */
  localModified?: string;
}

export type AgentBackend = 'auto' | 'harness' | 'claude-agent-sdk' | 'claude-cli' | 'http';
