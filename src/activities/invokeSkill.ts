/**
 * Skill invocation activity — two execution backends.
 *
 * Ported from tne-plugins/plugins/tne/engine/invoker.py.
 *
 * - Local (default): `claude -p` subprocess
 * - Horizon API: HTTP POST to FSM_INVOKE_URL
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { heartbeat } from '@temporalio/activity';
import {
  FSM_INVOKE_URL,
  FSM_INVOKE_SECRET,
  SKILL_INVOCATION_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
} from '../shared/constants.js';
import type { InvocationResult, Step } from '../shared/types.js';
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
 * Invoke a skill using the configured backend (Horizon API or local claude -p).
 */
export async function invokeSkill(
  step: Step,
  prompt: string,
): Promise<InvocationResult> {
  if (FSM_INVOKE_URL) {
    return invokeViaHorizon(prompt, step.model || undefined);
  }
  return invokeViaSubprocess(prompt, step.model || undefined, step.permissionMode);
}
