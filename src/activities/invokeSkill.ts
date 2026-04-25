/**
 * Skill invocation activity — three execution backends.
 *
 * Ported from tne-plugins/plugins/tne/engine/invoker.py.
 *
 * - agent-harness (default): @tne-ai/agent-harness streaming agent
 * - claude-agent-sdk: @anthropic-ai/claude-agent-sdk via agent-harness wrapper
 * - claude-cli: `claude -p` subprocess
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { heartbeat } from '@temporalio/activity';
import {
  createClaudeSDKAgent,
  resolveModelId,
} from '@tne-ai/agent-harness';
import {
  FSM_INVOKE_SECRET,
  SKILL_INVOCATION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  AGENT_BACKEND,
  HORIZON_FSM_START_URL,
  PERIODIC_S3_SYNC_INTERVAL_MS,
} from '../shared/constants.js';
import type { AgentBackend, InvocationResult, Step } from '../shared/types.js';
import { resolveTemplateVars } from '../config/templateResolver.js';
import { emitEvent, emitJobEvent } from './emitEvent.js';
import { pushWorkspaceToS3 } from './workspaceSync.js';
import { ensureSkillsInWorkspace } from './setupSkills.js';

/** Extract a short text preview for message events (strip surrounding whitespace). */
function previewText(text: string, max = 600): string {
  const s = text.trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** Detect Write/Edit tool uses that touch files — used to emit file_change events. */
function fileFromToolUse(toolName: string, input: any): string | null {
  if (!input || typeof input !== 'object') return null;
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return input.file_path || input.path || null;
  }
  return null;
}

/**
 * Normalize an agent-emitted file path to be workspace-root-relative
 * (i.e. include `workingDir` when the run is scoped to a subdir).
 *
 * The agent gets `cwd = workspaceRoot/workingDir`, so its tool inputs use
 * paths relative to that cwd — e.g. `TNE-CONTEXT/foo.md` actually lives at
 * `<workspaceRoot>/test1/TNE-CONTEXT/foo.md`. The frontend resolves
 * file_change paths via `/api/filesystem/read` (workspace-root-relative)
 * and `/api/s3/files/download` (S3-key-relative-to-user-prefix), both of
 * which need the workingDir prefix included. Without this normalization
 * the file viewer 404s on every artifact for any run with workingDir set.
 */
function normalizeFilePath(
  agentPath: string,
  workspaceRoot: string,
  workingDir?: string,
): string {
  if (!agentPath) return agentPath;
  // Absolute path from the agent — strip workspaceRoot if present.
  if (isAbsolute(agentPath)) {
    if (workspaceRoot && agentPath.startsWith(workspaceRoot)) {
      return relative(workspaceRoot, agentPath);
    }
    return agentPath;
  }
  // Relative path — interpreted against cwd, which is workspaceRoot/workingDir.
  return workingDir ? join(workingDir, agentPath) : agentPath;
}

/**
 * Start a background timer that pushes the workspace to S3 every 30s while the
 * skill invocation runs. Returns a stop() function that clears the timer and
 * awaits any in-flight upload. Failures are non-fatal — work-in-progress visibility
 * should never fail an invocation.
 */
function startPeriodicS3Sync(
  workspacePath: string,
  s3Bucket?: string,
  s3Prefix?: string,
  runId?: string,
  workingDir?: string,
): () => Promise<void> {
  if (!s3Bucket || !s3Prefix || !workspacePath) return async () => {};
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const doSync = async () => {
    try {
      const result = await pushWorkspaceToS3({
        bucket: s3Bucket,
        prefix: s3Prefix,
        localPath: workspacePath,
        scopePath: workingDir,
      });
      if (result.fileCount > 0) {
        emitEvent(runId, 'heartbeat', {
          status: 's3_sync',
          fileCount: result.fileCount,
          bytes: result.bytes,
        });
      }
    } catch (err) {
      console.error('[periodic-s3-sync] failed:', err);
    }
  };
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = doSync().finally(() => { inFlight = null; });
  }, PERIODIC_S3_SYNC_INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
    stopped = true;
    // Final sync captures writes made after the last interval tick.
    // Most skill invocations finish faster than the 30s interval, so
    // without this final push the workspace never makes it to S3 before
    // the workflow parks at stage review — leaving the UI with nothing
    // to show the approver.
    await doSync();
  };
}

/**
 * Build the full prompt for a skill invocation.
 *
 * Assembles the skill name, user task context (templateVars.PROMPT),
 * manifest of prior step outputs, iteration context, feedback, and notes.
 * Without templateVars.PROMPT the agent has no idea what the user actually
 * wants — every research skill just inventories whatever's in the workspace.
 */
export function buildPrompt(
  step: Step,
  iteration: number,
  templateVars: Record<string, string>,
  feedback?: string,
  humanNotes?: string,
  manifestPath?: string,
  manifestContent?: string,
): string {
  const parts: string[] = [];

  // Skill invocation
  parts.push(`Execute /${step.skill}`);

  // Notes from config (may contain template vars)
  if (step.notes) {
    const resolvedNotes = resolveTemplateVars(step.notes, templateVars);
    parts.push(resolvedNotes);
  }

  // User task context — the actual thing the user asked for. Goes high up
  // so every subagent knows the target before seeing the skill's SOP detail.
  const userPrompt = (templateVars.PROMPT || '').trim();
  if (userPrompt) {
    parts.push(`## Task Context\n\n${userPrompt}`);
  }

  // Non-PROMPT user-supplied variables as a structured reference. Skills
  // often have domain-specific vars (BEST_PRACTICE_DOMAINS, ORG, TOPIC, …)
  // that agents should honor even when not explicitly referenced by
  // {{VAR}} inside the SOP's notes column.
  const otherVars = Object.entries(templateVars).filter(([k, v]) =>
    k !== 'PROMPT' && k !== 'ITER' && v && String(v).trim().length > 0,
  );
  if (otherVars.length > 0) {
    const lines = otherVars.map(([k, v]) => `- **${k}**: ${v}`);
    parts.push(`## Run Variables\n\n${lines.join('\n')}`);
  }

  // Inline manifest: lists prior-step outputs the agent can consult. Faster
  // than asking the agent to read a separate manifest file and keeps the
  // prompt self-contained.
  if (manifestContent && manifestContent.trim()) {
    parts.push(`## Available Inputs\n\n${manifestContent.trim()}`);
  } else if (manifestPath && existsSync(manifestPath)) {
    parts.push(`Read the input manifest at: ${manifestPath}`);
  }

  // Output target
  if (step.output) {
    const resolvedOutput = resolveTemplateVars(step.output, templateVars)
      .replace('{{ITER}}', String(iteration || 1));
    parts.push(`Write output to: ${resolvedOutput}`);
  }

  // Iteration context
  if (iteration > 1) {
    parts.push(`[Iteration ${iteration}: Revising based on evaluator feedback]`);
  }

  // Evaluator feedback from previous iteration
  if (feedback) {
    parts.push(`## Feedback from Previous Evaluation\n\n${feedback}`);
  }

  // Human review notes
  if (humanNotes) {
    parts.push(`## Human Review Notes\n\n${humanNotes}`);
  }

  // Pass condition (for evaluators)
  if (step.passCondition) {
    parts.push(`## Pass Condition\n\n${step.passCondition}`);
  }

  return parts.join('\n\n');
}

/**
 * Invoke a skill via `claude -p` subprocess.
 *
 * Streams stdout/stderr, sends heartbeats periodically, and respects timeout.
 */
async function invokeViaSubprocess(
  prompt: string,
  model?: string,
  permissionMode = 'acceptEdits',
): Promise<InvocationResult> {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'text', '--permission-mode', permissionMode];
    if (model) args.push('--model', model);

    const proc = spawn('claude', args, {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Send prompt to stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Heartbeat periodically while subprocess runs
    const hbInterval = setInterval(() => {
      heartbeat({ status: 'running', stdoutLen: stdout.length });
    }, HEARTBEAT_INTERVAL_MS);

    // Timeout
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(hbInterval);
        proc.kill('SIGTERM');
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\nTimeout exceeded',
          exitCode: -1,
        });
      }
    }, SKILL_INVOCATION_TIMEOUT_MS);

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearInterval(hbInterval);
        clearTimeout(timeout);

        // Check if failure is only due to SessionEnd hook errors (non-fatal)
        const exitCode = code ?? 1;
        const onlyHookErrors = exitCode !== 0 && isOnlySessionEndHookError(stderr);

        resolve({
          success: exitCode === 0 || onlyHookErrors,
          stdout,
          stderr,
          exitCode,
        });
      }
    });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearInterval(hbInterval);
        clearTimeout(timeout);
        resolve({
          success: false,
          stdout,
          stderr: String(err),
          exitCode: 1,
        });
      }
    });
  });
}

/**
 * Check if all stderr lines are SessionEnd hook errors (non-fatal).
 */
function isOnlySessionEndHookError(stderr: string): boolean {
  const lines = stderr.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;
  return lines.every(line => /SessionEnd hook .+ failed:/i.test(line));
}

/**
 * Invoke a skill via the @tne-ai/agent-harness streaming agent.
 */
async function invokeViaHarness(
  prompt: string,
  model?: string,
  permissionMode?: string,
  workspacePath?: string,
  context?: { parentRunId?: string; jobId?: string; userId?: string; s3Bucket?: string; s3Prefix?: string; stepNumber?: string; skill?: string; workingDir?: string },
): Promise<InvocationResult> {
  const stopSync = startPeriodicS3Sync(workspacePath || '', context?.s3Bucket, context?.s3Prefix, context?.parentRunId, context?.workingDir);
  try {
    const { createAgent } = await import('@tne-ai/agent-harness');
    const resolvedModel = resolveModelId(model, 'agent');
    const workspaceRoot = workspacePath || process.cwd();
    const cwd = context?.workingDir ? join(workspaceRoot, context.workingDir) : workspaceRoot;
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    try { await ensureSkillsInWorkspace(cwd); } catch (err: any) {
      console.warn('[invokeViaHarness] ensureSkillsInWorkspace failed:', err?.message);
    }
    // Only pass a real API key as apiKey; OAuth tokens flow via env var and
    // must NOT be passed as ANTHROPIC_API_KEY (they're rejected as invalid).
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    const agent = createAgent({
      model: resolvedModel,
      cwd,
      permissionMode: (permissionMode as any) || 'bypassPermissions',
      // FSM steps can legitimately need many tool rounds (read/grep/edit/write
      // across a big workspace, plus nested skill invocations). 30 was too tight.
      maxTurns: 200,
      ...(apiKey ? { apiKey } : {}),
    });

    let stdout = '';
    let lastHeartbeat = Date.now();
    const runId = context?.parentRunId;
    const jobId = context?.jobId;

    for await (const event of agent.query(prompt)) {
      // Agent harness emits various event types — capture text content from assistant messages
      const ev = event as any;
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text') {
            stdout += block.text;
            const text = previewText(block.text);
            emitEvent(runId, 'message', { backend: 'harness', text, stepNumber: context?.stepNumber, skill: context?.skill });
            emitJobEvent(jobId, 'message', { backend: 'harness', text });
          } else if (block.type === 'tool_use') {
            emitEvent(runId, 'tool_use', { backend: 'harness', tool: block.name, input: block.input, stepNumber: context?.stepNumber, skill: context?.skill });
            emitJobEvent(jobId, 'tool_use', { backend: 'harness', tool: block.name, input: block.input, toolUseId: block.id });
            const file = fileFromToolUse(block.name, block.input);
            if (file) {
              const normalized = normalizeFilePath(file, workspaceRoot, context?.workingDir);
              emitEvent(runId, 'file_change', { tool: block.name, path: normalized, stepNumber: context?.stepNumber, skill: context?.skill });
              emitJobEvent(jobId, 'file_change', { tool: block.name, path: normalized });
            }
          }
        }
      } else if (ev.type === 'user' && ev.message?.content) {
        // The harness emits user messages carrying tool_result blocks back from
        // the runtime. Surface those so the UI can pair tool_use → tool_result.
        for (const block of ev.message.content) {
          if (block.type === 'tool_result') {
            const out = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('')
                : '';
            emitJobEvent(jobId, 'tool_result', {
              backend: 'harness',
              toolUseId: block.tool_use_id,
              output: previewText(String(out)),
              isError: !!block.is_error,
            });
          }
        }
      } else if (ev.type === 'result') {
        if (typeof ev.text === 'string') stdout += ev.text;
        // Surface token usage so the UI can render per-step spend. The harness
        // forwards Anthropic's usage object straight through on the result event.
        const usage = ev.usage;
        if (usage && (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')) {
          const tokenPayload = {
            backend: 'harness',
            model: resolvedModel,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          };
          emitEvent(runId, 'token_update', { ...tokenPayload, stepNumber: context?.stepNumber, skill: context?.skill });
          emitJobEvent(jobId, 'token_update', tokenPayload);
        }
      }
      // Heartbeat every 5 seconds
      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        heartbeat({ status: 'running', backend: 'harness', len: stdout.length });
        lastHeartbeat = Date.now();
      }
    }

    return { success: true, stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: String(err),
      exitCode: 1,
    };
  } finally {
    await stopSync().catch(() => {});
  }
}

/**
 * Build a PreToolUse hook that intercepts `fsm-start` bash commands and routes
 * them to Horizon's /api/fsm-invoke/start with parentRunId set. This makes
 * nested p-* orchestrator invocations register as child FsmRuns.
 *
 * If HORIZON_FSM_START_URL is not configured the hooks object is empty and the
 * fsm-start command falls through to whatever the subprocess PATH resolves —
 * same behavior as before this change.
 */
function buildNestedFsmHooks(
  context?: { parentRunId?: string; userId?: string },
): Record<string, any[]> | undefined {
  if (!HORIZON_FSM_START_URL || !context?.parentRunId) return undefined;

  return {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          async (input: any) => {
            try {
              const command: string | undefined = input?.tool_input?.command;
              if (!command || typeof command !== 'string') return {};
              const match = command.match(
                /(?:^|\s|&&\s*|;\s*)(?:\.\/)?(?:\.local\/bin\/)?fsm-start\s+([\w-]+)(.*)$/,
              );
              if (!match) return {};
              const skillName = match[1];
              const flags = match[2] || '';
              const resume = /\s--resume\b/.test(flags);

              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
              };
              if (FSM_INVOKE_SECRET) headers['x-fsm-secret'] = FSM_INVOKE_SECRET;

              const response = await fetch(HORIZON_FSM_START_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  skillName,
                  userId: context.userId,
                  resume,
                  parentRunId: context.parentRunId,
                  useTemporal: true,
                }),
              });

              if (!response.ok) {
                const text = await response.text().catch(() => '');
                return {
                  hookSpecificOutput: {
                    ...input,
                    tool_input: {
                      ...input.tool_input,
                      command: `echo 'fsm-start failed: HTTP ${response.status} — ${text.replace(/'/g, "'\\''")}'`,
                    },
                  },
                };
              }

              const data: any = await response.json().catch(() => ({}));

              // Surface the spawn on the parent's event stream so the Agent
              // Tree / App Events views update immediately, before the child
              // starts emitting its own events.
              emitEvent(context.parentRunId, 'child_run_started', {
                childRunId: data.runId,
                skill: skillName,
                resumed: resume,
              });

              return {
                hookSpecificOutput: {
                  ...input,
                  tool_input: {
                    ...input.tool_input,
                    command: `echo 'FSM child run started. Parent: ${context.parentRunId} Child: ${data.runId || 'unknown'} Skill: ${skillName}'`,
                  },
                },
              };
            } catch (err: any) {
              return {
                hookSpecificOutput: {
                  ...input,
                  tool_input: {
                    ...input.tool_input,
                    command: `echo 'fsm-start hook error: ${String(err?.message || err).replace(/'/g, "'\\''")}'`,
                  },
                },
              };
            }
          },
        ],
      },
    ],
  };
}

/**
 * Invoke a skill via the official Claude Agent SDK.
 *
 * Uses @tne-ai/agent-harness's createClaudeSDKAgent() wrapper which provides:
 * - Full tool support (Read, Write, Edit, Bash, Glob, Grep, WebSearch, etc.)
 * - System prompt from CLAUDE.md
 * - Extended thinking (16k budget)
 * - 1M context window
 * - bypassPermissions mode
 * - Model resolution (aliases → full IDs)
 */
async function invokeViaClaudeAgentSDK(
  prompt: string,
  model?: string,
  workspacePath?: string,
  context?: { parentRunId?: string; jobId?: string; userId?: string; s3Bucket?: string; s3Prefix?: string; stepNumber?: string; skill?: string; workingDir?: string },
): Promise<InvocationResult> {
  const resolvedModel = resolveModelId(model, 'agent');
  const workspaceRoot = workspacePath || process.cwd();
  const cwd = context?.workingDir ? join(workspaceRoot, context.workingDir) : workspaceRoot;
  // Ensure workspace directory exists before spawning Claude Code
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  // Populate `.claude/skills/` with symlinks to tne-plugins so Skill() lookups
  // resolve from cwd. Non-fatal on failure — the agent will just miss the
  // skill and have to improvise, which is what we saw before this fix.
  try { await ensureSkillsInWorkspace(cwd); } catch (err: any) {
    console.warn('[invokeViaClaudeAgentSDK] ensureSkillsInWorkspace failed:', err?.message);
  }
  console.log(`[invokeViaClaudeAgentSDK] model=${resolvedModel}, workspace=${cwd}`);

  // Sync loop walks the workspace ROOT, scoped to workingDir, so the S3 key
  // layout matches what horizon pushed (e.g. `{userId}/test1/file.md`). Using
  // `cwd` as localPath unscoped would nest already-present siblings under
  // the subdir on subsequent pulls.
  const stopSync = startPeriodicS3Sync(workspaceRoot, context?.s3Bucket, context?.s3Prefix, context?.parentRunId, context?.workingDir);
  try {
    const agent = createClaudeSDKAgent({
      model: resolvedModel,
      cwd,
      permissionMode: 'bypassPermissions',
      persistSession: false,
      // FSM steps can legitimately need many tool rounds. 30 was the observed
      // cap that failed p-cso1-write-business-plan mid-execution.
      maxTurns: 200,
      wrapPrompt: true,
      workspacePath,
      hooks: buildNestedFsmHooks(context),
      env: (() => {
        // OAuth tokens (sk-ant-oat01-…) must stay in CLAUDE_CODE_OAUTH_TOKEN.
        // They are NOT valid as ANTHROPIC_API_KEY and will be rejected with
        // "Invalid API key" if sent via x-api-key.
        const out: Record<string, string> = { ...(process.env as Record<string, string>) };
        const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (oauth && (!apiKey || !apiKey.trim())) {
          delete out.ANTHROPIC_API_KEY;
          out.CLAUDE_CODE_OAUTH_TOKEN = oauth;
        }
        return out;
      })(),
    });

    let stdout = '';
    let lastHeartbeat = Date.now();
    const runId = context?.parentRunId;
    const jobId = context?.jobId;

    for await (const event of agent.query(prompt)) {
      // Capture text from assistant messages + emit message/tool_use/file_change events
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            stdout += block.text;
            const text = previewText(block.text);
            emitEvent(runId, 'message', { backend: 'claude-agent-sdk', text, stepNumber: context?.stepNumber, skill: context?.skill });
            emitJobEvent(jobId, 'message', { backend: 'claude-agent-sdk', text });
          } else if (block.type === 'tool_use') {
            emitEvent(runId, 'tool_use', { backend: 'claude-agent-sdk', tool: block.name, input: block.input, stepNumber: context?.stepNumber, skill: context?.skill });
            emitJobEvent(jobId, 'tool_use', { backend: 'claude-agent-sdk', tool: block.name, input: block.input, toolUseId: (block as any).id });
            const file = fileFromToolUse(block.name, block.input);
            if (file) {
              const normalized = normalizeFilePath(file, workspaceRoot, context?.workingDir);
              emitEvent(runId, 'file_change', { tool: block.name, path: normalized, stepNumber: context?.stepNumber, skill: context?.skill });
              emitJobEvent(jobId, 'file_change', { tool: block.name, path: normalized });
            }
          }
        }
      } else if ((event as any).type === 'user' && (event as any).message?.content) {
        for (const block of (event as any).message.content) {
          if (block.type === 'tool_result') {
            const out = typeof block.content === 'string' ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('')
                : '';
            emitJobEvent(jobId, 'tool_result', {
              backend: 'claude-agent-sdk',
              toolUseId: block.tool_use_id,
              output: previewText(String(out)),
              isError: !!block.is_error,
            });
          }
        }
      }

      // Capture final result
      if (event.type === 'result') {
        if (event.result) stdout = event.result;

        const usage = (event as any).usage;
        if (usage && (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')) {
          const tokenPayload = {
            backend: 'claude-agent-sdk',
            model: resolvedModel,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
            costUsd: typeof (event as any).total_cost_usd === 'number' ? (event as any).total_cost_usd : undefined,
          };
          emitEvent(runId, 'token_update', { ...tokenPayload, stepNumber: context?.stepNumber, skill: context?.skill });
          emitJobEvent(jobId, 'token_update', tokenPayload);
        }

        // Trust subtype over is_error — the SDK may set is_error on successful completions
        if (event.subtype !== 'success') {
          const errorMsg = event.errors?.join('; ') || event.subtype || 'Unknown error';
          console.error('[invokeViaClaudeAgentSDK] SDK error:', errorMsg);
          return {
            success: false,
            stdout,
            stderr: errorMsg,
            exitCode: 1,
          };
        }
      }

      // Heartbeat
      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        heartbeat({ status: 'running', backend: 'claude-agent-sdk', len: stdout.length });
        lastHeartbeat = Date.now();
      }
    }

    return { success: true, stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    console.error('[invokeViaClaudeAgentSDK] Error:', err);
    return {
      success: false,
      stdout: '',
      stderr: String(err),
      exitCode: 1,
    };
  } finally {
    await stopSync().catch(() => {});
  }
}

/**
 * Invoke a skill using the specified or configured backend.
 *
 * Backend selection priority:
 * 1. Per-request agentBackend parameter (from workflow input)
 * 2. AGENT_BACKEND env var — 'harness' | 'claude-agent-sdk' | 'claude-cli'
 */
export async function invokeSkill(
  step: Step,
  prompt: string,
  workspacePath?: string,
  agentBackend?: AgentBackend,
  context?: { parentRunId?: string; jobId?: string; userId?: string; s3Bucket?: string; s3Prefix?: string; workingDir?: string },
): Promise<InvocationResult> {
  const backend = agentBackend || AGENT_BACKEND;
  console.log(`[invokeSkill] backend=${backend}, skill=${step.skill}, model=${step.model || 'default'}, parentRunId=${context?.parentRunId || ''}`);

  // Thread step identity into the inner invocation so the harness/SDK paths can
  // stamp `stepNumber` + `skill` onto the `token_update` event they emit from
  // the final `result`. Without this, per-step spend can't be attributed on
  // the UI side.
  const innerContext = { ...(context || {}), stepNumber: step.number, skill: step.skill };

  switch (backend) {
    case 'harness':
      return invokeViaHarness(prompt, step.model || undefined, step.permissionMode, workspacePath, innerContext);
    case 'claude-agent-sdk':
      return invokeViaClaudeAgentSDK(prompt, step.model || undefined, workspacePath, innerContext);
    case 'claude-cli':
    default:
      return invokeViaSubprocess(prompt, step.model || undefined, step.permissionMode);
  }
}
