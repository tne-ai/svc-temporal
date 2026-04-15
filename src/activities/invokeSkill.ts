/**
 * Skill invocation activity — four execution backends.
 *
 * Ported from tne-plugins/plugins/tne/engine/invoker.py.
 *
 * - agent-harness (default): @tne-ai/agent-harness streaming agent
 * - claude-agent-sdk: @anthropic-ai/claude-agent-sdk via agent-harness wrapper
 * - claude-cli: `claude -p` subprocess
 * - http: HTTP POST to FSM_INVOKE_URL (Horizon API)
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { heartbeat } from '@temporalio/activity';
import {
  createClaudeSDKAgent,
  resolveModelId,
} from '@tne-ai/agent-harness';
import {
  FSM_INVOKE_URL,
  FSM_INVOKE_SECRET,
  SKILL_INVOCATION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  AGENT_BACKEND,
} from '../shared/constants.js';
import type { AgentBackend, InvocationResult, Step } from '../shared/types.js';
import { resolveTemplateVars } from '../config/templateResolver.js';

/**
 * Build the full prompt for a skill invocation.
 *
 * Assembles the skill name, manifest reference, iteration context,
 * feedback from previous evaluators, and human notes.
 */
export function buildPrompt(
  step: Step,
  iteration: number,
  templateVars: Record<string, string>,
  feedback?: string,
  humanNotes?: string,
  manifestPath?: string,
): string {
  const parts: string[] = [];

  // Skill invocation
  parts.push(`Execute /${step.skill}`);

  // Notes from config (may contain template vars)
  if (step.notes) {
    const resolvedNotes = resolveTemplateVars(step.notes, templateVars);
    parts.push(resolvedNotes);
  }

  // Manifest reference
  if (manifestPath && existsSync(manifestPath)) {
    parts.push(`\nRead the input manifest at: ${manifestPath}`);
  }

  // Output target
  if (step.output) {
    const resolvedOutput = resolveTemplateVars(step.output, templateVars)
      .replace('{{ITER}}', String(iteration || 1));
    parts.push(`\nWrite output to: ${resolvedOutput}`);
  }

  // Iteration context
  if (iteration > 1) {
    parts.push(`\n[Iteration ${iteration}: Revising based on evaluator feedback]`);
  }

  // Evaluator feedback from previous iteration
  if (feedback) {
    parts.push(`\n## Feedback from Previous Evaluation\n\n${feedback}`);
  }

  // Human review notes
  if (humanNotes) {
    parts.push(`\n## Human Review Notes\n\n${humanNotes}`);
  }

  // Pass condition (for evaluators)
  if (step.passCondition) {
    parts.push(`\n## Pass Condition\n\n${step.passCondition}`);
  }

  return parts.join('\n\n');
}

/**
 * Invoke a skill via the Horizon API (HTTP POST).
 */
async function invokeViaHorizon(
  prompt: string,
  model?: string,
): Promise<InvocationResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (FSM_INVOKE_SECRET) {
    headers['Authorization'] = `Bearer ${FSM_INVOKE_SECRET}`;
  }

  try {
    const response = await fetch(FSM_INVOKE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, model: model || '' }),
      signal: AbortSignal.timeout(SKILL_INVOCATION_TIMEOUT_MS),
    });

    const text = await response.text();
    return {
      success: response.ok,
      stdout: text,
      stderr: '',
      exitCode: response.ok ? 0 : 1,
    };
  } catch (err) {
    return {
      success: false,
      stdout: '',
      stderr: String(err),
      exitCode: 1,
    };
  }
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
): Promise<InvocationResult> {
  try {
    const { createAgent } = await import('@tne-ai/agent-harness');
    const resolvedModel = resolveModelId(model, 'agent');
    // Support both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const agent = createAgent({
      model: resolvedModel,
      cwd: workspacePath || process.cwd(),
      permissionMode: (permissionMode as any) || 'bypassPermissions',
      maxTurns: 30,
      ...(apiKey ? { apiKey } : {}),
    });

    let stdout = '';
    let lastHeartbeat = Date.now();

    for await (const event of agent.query(prompt)) {
      // Agent harness emits various event types — capture text content from assistant messages
      const ev = event as any;
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text') stdout += block.text;
        }
      } else if (ev.type === 'result') {
        if (typeof ev.text === 'string') stdout += ev.text;
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
  }
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
): Promise<InvocationResult> {
  const resolvedModel = resolveModelId(model, 'agent');
  console.log(`[invokeViaClaudeAgentSDK] model=${resolvedModel}, workspace=${workspacePath || 'cwd'}`);

  try {
    const agent = createClaudeSDKAgent({
      model: resolvedModel,
      cwd: workspacePath || process.cwd(),
      permissionMode: 'bypassPermissions',
      persistSession: false,
      maxTurns: 30,
      wrapPrompt: true,
      workspacePath,
      env: {
        ...process.env as Record<string, string>,
        // Ensure OAuth token is available
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: process.env.CLAUDE_CODE_OAUTH_TOKEN }
          : {}),
      },
    });

    let stdout = '';
    let lastHeartbeat = Date.now();

    for await (const event of agent.query(prompt)) {
      // Capture text from assistant messages
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') stdout += block.text;
        }
      }

      // Capture final result
      if (event.type === 'result') {
        if (event.result) stdout = event.result;

        if (event.is_error || event.subtype !== 'success') {
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
  }
}

/**
 * Invoke a skill using the specified or configured backend.
 *
 * Backend selection priority:
 * 1. FSM_INVOKE_URL (HTTP override) — always takes priority if set
 * 2. Per-request agentBackend parameter (from workflow input)
 * 3. AGENT_BACKEND env var — 'harness' | 'claude-agent-sdk' | 'claude-cli'
 */
export async function invokeSkill(
  step: Step,
  prompt: string,
  workspacePath?: string,
  agentBackend?: AgentBackend,
): Promise<InvocationResult> {
  // HTTP override takes priority
  if (FSM_INVOKE_URL) {
    return invokeViaHorizon(prompt, step.model || undefined);
  }

  const backend = agentBackend || AGENT_BACKEND;
  console.log(`[invokeSkill] backend=${backend}, skill=${step.skill}, model=${step.model || 'default'}`);

  switch (backend) {
    case 'harness':
      return invokeViaHarness(prompt, step.model || undefined, step.permissionMode, workspacePath);
    case 'claude-agent-sdk':
      return invokeViaClaudeAgentSDK(prompt, step.model || undefined, workspacePath);
    case 'claude-cli':
    default:
      return invokeViaSubprocess(prompt, step.model || undefined, step.permissionMode);
  }
}
