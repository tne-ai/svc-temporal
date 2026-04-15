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
  number: number;
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
  /** Parsed process config from SKILL.md */
  config: ProcessConfig;
  /** Template variables resolved from inputs file */
  templateVars: Record<string, string>;
  /** Path to the workspace directory */
  workspacePath: string;
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
  workspacePath: string;
  manifestPath?: string;
  agentBackend?: AgentBackend;
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
