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
}

export interface InvocationResult {
  success: boolean;
  stdout: string;
  stderr: string;
  outputPath?: string;
  exitCode: number;
  stageReviewPause?: boolean;
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
}

export interface JobResult {
  status: 'completed' | 'failed';
  output: string;
  outputFiles?: string[];
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

export type AgentBackend = 'harness' | 'claude-agent-sdk' | 'claude-cli' | 'http';
