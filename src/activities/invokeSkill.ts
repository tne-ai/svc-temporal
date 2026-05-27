/**
 * Skill invocation activity — three execution backends.
 *
 * Ported from tne-plugins/plugins/tne/engine/invoker.py.
 *
 * - pi             (formerly 'harness'): non-Anthropic streaming via Pi
 * - claude-agent-sdk: @anthropic-ai/claude-agent-sdk
 * - claude-cli:     `claude -p` subprocess
 *
 * Note: the dispatcher still accepts `'harness'` as a backend name to
 * avoid breaking workflows / env vars that pin it explicitly. After the
 * agent-harness package was retired we routed that case through Pi
 * instead — same external surface, no harness dependency.
 */

/**
 * Pull token counts out of a usage object regardless of shape. Anthropic
 * emits `input_tokens` / `output_tokens` + cache-aware fields; OpenAI-
 * compatible providers (OpenRouter, DeepSeek, Kimi, etc.) emit
 * `prompt_tokens` / `completion_tokens` with no cache breakdown.
 *
 * Returns the same shape orion's jobService.applyTokenUpdate /
 * fsmService.applyTokenUpdate expect (camelCase). When the input usage
 * has neither key, returns null — the caller skips the emit.
 */
function normalizeUsage(usage: any): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
} | null {
  if (!usage || typeof usage !== 'object') return null;
  // Anthropic shape first — when both shapes are present (some routers
  // pass through both) we prefer Anthropic because it carries cache info.
  if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    };
  }
  // OpenAI / OpenRouter shape.
  if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') {
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }
  return null;
}

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import { heartbeat } from '@temporalio/activity';
import {
  createClaudeSDKAgent,
  resolveModelId,
} from '../services/claudeSdkAgent.js';
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
import { fetchUserProviderKey } from '../lib/fetchUserProviderKey.js';
import { ensureSkillsInWorkspace } from './setupSkills.js';
import { PiAgentSession, isPiAgentEnabled, isLiteLLMProxyEnabled, getLiteLLMBaseURL, normalizeModelForLitellm } from '../services/piAgentAdapter.js';
import { buildPiTools } from '../services/piAgentTools.js';
import { loadLeafSkillSchema } from '../config/leafSkillSchema.js';

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
 * Invoke a skill via Pi (@mariozechner/pi-agent-core) for non-Anthropic
 * upstreams (OpenRouter, OpenAI, Gemini, anything via LiteLLM proxy).
 *
 * Anthropic-direct invocations don't go through here — they take the
 * `claude-agent-sdk` path via invokeViaClaudeAgentSDK, which natively
 * understands Claude Max OAuth (CLAUDE_CODE_OAUTH_TOKEN) and the
 * Claude Code tool loop.
 *
 * Function name retained as `invokeViaHarness` only to keep the
 * dispatcher contract stable — see comment on the top of file.
 */
async function invokeViaHarness(
  prompt: string,
  model?: string,
  _permissionMode?: string,
  workspacePath?: string,
  context?: { parentRunId?: string; jobId?: string; userId?: string; s3Bucket?: string; s3Prefix?: string; stepNumber?: string; skill?: string; workingDir?: string },
): Promise<InvocationResult> {
  const stopSync = startPeriodicS3Sync(workspacePath || '', context?.s3Bucket, context?.s3Prefix, context?.parentRunId, context?.workingDir);
  // Pi session captured in the outer scope so the finally block can
  // dispose it even if the body throws partway through.
  let piSession: PiAgentSession | null = null;
  try {
    let resolvedModel = resolveModelId(model);
    const workspaceRoot = workspacePath || process.cwd();
    const cwd = context?.workingDir ? join(workspaceRoot, context.workingDir) : workspaceRoot;
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
    try { await ensureSkillsInWorkspace(cwd); } catch (err: any) {
      console.warn('[invokeViaPi] ensureSkillsInWorkspace failed:', err?.message);
    }
    // Provider routing. Pi requires an explicit apiType / baseURL — by
    // default it would treat the model as anthropic-messages and call
    // api.anthropic.com, which 404s on `moonshotai/kimi-k2.6`. Detect
    // non-Anthropic models by their slug shape (`vendor/model`) and
    // wire OpenRouter the same way orion's agentService does.
    const isOpenRouterModel = !!resolvedModel && resolvedModel.includes('/');
    let apiType: 'anthropic-messages' | 'openai-completions' = 'anthropic-messages';
    let baseURL: string | undefined;
    let apiKey: string | undefined;

    // BYOK lookup: if the user has a saved key for the relevant provider,
    // use it instead of the env-var fallback. SOC2-compliant: keys are
    // fetched from orion's authenticated internal endpoint over HTTPS,
    // used once for this activity, never persisted on the worker.
    const byokProvider = isOpenRouterModel ? 'openrouter' : 'anthropic';
    const byokKey = context?.userId
      ? await fetchUserProviderKey(context.userId, byokProvider)
      : null;

    // LiteLLM proxy routing — same pattern as orion's agentService.ts.
    // When USE_LITELLM_PROXY is on, every upstream goes through the proxy
    // as openai-completions; the proxy handles per-provider translation +
    // auth via LITELLM_MASTER_KEY. Bypasses the BYOK / OAuth paths below.
    const useLiteLLM = isLiteLLMProxyEnabled();
    if (useLiteLLM) {
      apiType = 'openai-completions';
      baseURL = getLiteLLMBaseURL();
      apiKey = process.env.LITELLM_MASTER_KEY?.trim();
      // Translate to the proxy's flat alias scheme (or-* for OpenRouter
      // upstreams; bare ids for direct Anthropic / OpenAI / Gemini).
      resolvedModel = normalizeModelForLitellm(byokProvider, resolvedModel);
      if (!apiKey) {
        console.warn(
          '[invokeViaPi] USE_LITELLM_PROXY=true but LITELLM_MASTER_KEY is unset — request will fail',
          { baseURL, model: resolvedModel },
        );
      } else {
        console.log('[invokeViaPi] routing through LiteLLM proxy', {
          baseURL,
          model: resolvedModel,
          upstream: byokProvider,
        });
      }
    } else if (isOpenRouterModel) {
      apiType = 'openai-completions';
      baseURL = 'https://openrouter.ai/api/v1';
      apiKey = byokKey || process.env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) {
        return {
          success: false,
          stdout: '',
          stderr:
            `invokeViaPi aborted: no OpenRouter credentials available for model "${resolvedModel}". ` +
            `Either save a BYOK OpenRouter key on the user's profile, or set OPENROUTER_API_KEY ` +
            `in svc-temporal's deployment env (envFrom: openrouter-secrets).`,
          exitCode: 1,
        };
      } else if (byokKey) {
        console.log('[invokeViaPi] using BYOK OpenRouter key', { userId: context?.userId });
      }
    } else {
      // Anthropic via the Pi path — only used when AGENT_BACKEND is
      // forced to 'harness' for an Anthropic model. Auto routing sends
      // Anthropic to invokeViaClaudeAgentSDK, which is the path that
      // understands Claude Max OAuth. Pi expects an apiKey, so without
      // a BYOK / env API key we fail fast — OAuth-via-env was a
      // harness-only fallback we no longer support on this path.
      apiKey = byokKey || process.env.ANTHROPIC_API_KEY?.trim();
      if (byokKey) {
        console.log('[invokeViaPi] using BYOK Anthropic key', { userId: context?.userId });
      }
      if (!apiKey) {
        return {
          success: false,
          stdout: '',
          stderr:
            `invokeViaPi aborted: no Anthropic API key available for model "${resolvedModel}". ` +
            `For Claude Max OAuth (CLAUDE_CODE_OAUTH_TOKEN), set AGENT_BACKEND=auto so the ` +
            `claude-agent-sdk path handles the request, or save a BYOK Anthropic key.`,
          exitCode: 1,
        };
      }
    }
    // Pi requires explicit apiKey + tools. With the harness retired
    // there is no longer a fallback path — every call goes through Pi
    // here. The adapter emits harness-shaped events so the existing
    // consumer loop below works unchanged.
    if (!isPiAgentEnabled()) {
      console.warn('[invokeViaPi] USE_PI_AGENT is unset — enabling implicitly (harness backend retired)');
    }
    const piTools = buildPiTools(cwd, { sessionKey: context?.parentRunId || cwd });
    // `resolvedModel` was already normalized for the LiteLLM branch
    // above (line ~383) if proxy mode is on. For direct upstreams
    // (OpenRouter / Anthropic) we need to pass the model id the
    // upstream expects — e.g. `moonshotai/kimi-k2.6` for OpenRouter,
    // not LiteLLM's `or-kimi-k2.6` alias. Previously we were calling
    // `normalizeModelForLitellm` here unconditionally, which broke
    // direct-to-OpenRouter calls with "400 or-kimi-k2.6 is not a
    // valid model id".
    const piModel = resolvedModel;
    console.log('[invokeViaPi] using Pi agent', {
      model: piModel,
      apiType,
      provider: byokProvider,
      toolCount: piTools.length,
      baseURL,
      useLiteLLM,
    });
    piSession = new PiAgentSession({
      apiType,
      model: piModel,
      apiKey: apiKey!,
      baseURL,
      cwd,
      systemPrompt:
        'You are a skill execution agent running inside a temporal worker. ' +
        'Use the provided tools (Read/Write/Edit/Bash/Glob/Grep) to accomplish the task in the workspace. ' +
        'Files written or edited will be synced to S3 after the run completes.',
      tools: piTools,
      maxTokens: 16384,
      provider: byokProvider,
    });
    const session = piSession;
    const agent: { query: (prompt: string) => AsyncIterable<any> } = {
      query: (p: string) => session.query(p),
    };

    let stdout = '';
    let lastHeartbeat = Date.now();
    const runId = context?.parentRunId;
    const jobId = context?.jobId;
    // Track whether the harness actually did any work. If the underlying
    // API call fails (auth, model-not-found, etc.) the harness may emit a
    // `result` event with is_error=true and 0 tokens but no thrown
    // exception — silently green from invokeViaHarness's caller. Capture
    // the failure reason so executeStep's step_failed surfaces *why*.
    let harnessError: string | null = null;
    let harnessSawAnyTokens = false;
    let harnessSawAnyToolUse = false;

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
      } else if (ev.type === 'partial_message' && typeof ev.delta?.text === 'string') {
        // Pi adapter path: streaming token deltas. We *don't* emit a job
        // event per delta (the activity log would fill with hundreds of
        // one-word entries — see the user's screenshot). Just track the
        // signal that the model produced output. The full text gets
        // emitted as a single coalesced `assistant` event on
        // message_end, which the existing assistant-text handler above
        // turns into one job-event message per assistant turn.
        harnessSawAnyTokens = true;
      } else if (ev.type === 'tool_result' && ev.result) {
        // Pi adapter path: tool results arrive as top-level events rather
        // than nested in a `user` message. Mirror the same job-event emit.
        const r = ev.result;
        emitJobEvent(jobId, 'tool_result', {
          backend: 'harness',
          toolUseId: r.tool_use_id,
          output: previewText(String(r.output || '')),
          isError: !!r.is_error,
        });
      } else if (ev.type === 'result') {
        if (typeof ev.text === 'string') stdout += ev.text;
        // Surface token usage so the UI can render per-step spend. The
        // harness path runs against many backends — Anthropic Claude
        // (input_tokens / output_tokens) and OpenAI-compatible providers
        // (prompt_tokens / completion_tokens via OpenRouter, DeepSeek,
        // Kimi, …). Normalize both into the canonical camelCase payload
        // orion's applyTokenUpdate expects.
        const norm = normalizeUsage(ev.usage);
        if (norm) {
          if (norm.inputTokens > 0 || norm.outputTokens > 0) harnessSawAnyTokens = true;
          const tokenPayload = {
            backend: 'harness',
            model: resolvedModel,
            ...norm,
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          };
          emitEvent(runId, 'token_update', { ...tokenPayload, stepNumber: context?.stepNumber, skill: context?.skill });
          emitJobEvent(jobId, 'token_update', tokenPayload);
        }
        // Detect harness-reported errors. The harness emits is_error / an
        // error subtype when the underlying API call fails (bad auth,
        // model-not-found, rate-limit, etc.). Without this surface, the
        // outer step_failed only says "no file was written" with no clue
        // why — the actual reason was buried in a result event we
        // ignored.
        if ((ev as any).is_error === true || (typeof ev.subtype === 'string' && ev.subtype.includes('error'))) {
          const rawDetail =
            (ev as any).error ||
            (ev as any).message ||
            (ev as any).subtype ||
            'unknown harness error';
          // The harness sometimes emits {subtype:'error'} with no error/
          // message field — that produced the unhelpful "harness errored:
          // error" message in production. Tack on enough context for the
          // user to act on (model + provider + apiKey-presence), and a
          // hint at the most likely cause when the detail is opaque.
          const looksOpaque = rawDetail === 'error' || rawDetail === 'unknown harness error';
          const ctx = ` (model=${resolvedModel}, provider=${byokProvider}, apiKey=${apiKey ? 'set' : 'missing'}${baseURL ? `, baseURL=${baseURL}` : ''})`;
          const hint = looksOpaque
            ? ' — likely an upstream auth failure (401), unknown model id (404), or rate limit. Check the worker logs for the underlying provider response.'
            : '';
          harnessError = `pi errored: ${rawDetail}${ctx}${hint}`;
          console.warn('[invokeViaPi] Pi reported error in result event', {
            model: resolvedModel,
            provider: byokProvider,
            baseURL,
            apiKeyPresent: !!apiKey,
            subtype: (ev as any).subtype,
            isError: (ev as any).is_error,
            error: rawDetail,
          });
        }
      } else if (ev.type === 'assistant' && (ev as any).message?.content) {
        for (const block of (ev as any).message.content) {
          if (block.type === 'tool_use') harnessSawAnyToolUse = true;
        }
      }
      // Heartbeat every 5 seconds
      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
        heartbeat({ status: 'running', backend: 'harness', len: stdout.length });
        lastHeartbeat = Date.now();
      }
    }

    // Surface Pi-level failures up to executeStep so step_failed
    // includes a useful diagnostic. Three escalating signals:
    //   1. explicit `is_error` / error subtype on a result event → propagate verbatim
    //   2. zero tokens AND no tool uses → almost always a silent
    //      provider failure (bad auth, missing OPENROUTER_API_KEY,
    //      404 on a non-existent model slug). Hint at the most likely
    //      cause based on the model shape.
    //   3. otherwise: real success
    if (harnessError) {
      return { success: false, stdout, stderr: harnessError, exitCode: 1 };
    }
    if (!harnessSawAnyTokens && !harnessSawAnyToolUse) {
      const isOR = !!resolvedModel && resolvedModel.includes('/');
      const orHint = isOR
        ? ` (OpenRouter slug — check OPENROUTER_API_KEY is set in svc-temporal's env and that "${resolvedModel}" is a valid OR model id)`
        : ' (Anthropic via Pi — check ANTHROPIC_API_KEY)';
      const detail = `pi returned 0 tokens and made no tool calls — the LLM call almost certainly failed silently${orHint}`;
      console.warn('[invokeViaPi] suspected silent failure', {
        model: resolvedModel,
        isOpenRouterModel: isOR,
      });
      return { success: false, stdout, stderr: detail, exitCode: 1 };
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
    // Pi sessions hold a long-lived Agent instance; harness's createAgent
    // doesn't need explicit teardown. Either way, drain the periodic sync.
    if (piSession) { try { piSession.dispose(); } catch {/* idempotent */} }
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
            // Hook input shape varies by runtime: the Claude Code SDK
            // path uses snake_case tool_input, while Pi (and the
            // retired harness) used camelCase toolInput. Read both
            // shapes so this works in either runtime.
            //
            // Before the dual-shape read, the snake_case-only read
            // meant this hook had been a silent no-op on the
            // harness/Pi path: every fsm-start bash command from inside
            // a skill ran as a plain subprocess instead of being
            // redirected to /api/fsm-invoke/start with parentRunId —
            // so nested orchestrator child runs were never linked to
            // their parent in the Job Tree / App Events views.
            const inputToolInput = input?.toolInput || input?.tool_input || {};
            const buildOutput = (newCommand: string) => ({
              hookSpecificOutput: {
                ...input,
                // Set both shapes so callers (camelCase or snake_case)
                // both pick up the rewritten command.
                toolInput: { ...inputToolInput, command: newCommand },
                tool_input: { ...inputToolInput, command: newCommand },
              },
            });

            try {
              const command: string | undefined = inputToolInput?.command;
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
                return buildOutput(
                  `echo 'fsm-start failed: HTTP ${response.status} — ${text.replace(/'/g, "'\\''")}'`,
                );
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

              return buildOutput(
                `echo 'FSM child run started. Parent: ${context.parentRunId} Child: ${data.runId || 'unknown'} Skill: ${skillName}'`,
              );
            } catch (err: any) {
              return buildOutput(
                `echo 'fsm-start hook error: ${String(err?.message || err).replace(/'/g, "'\\''")}'`,
              );
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
 * Uses our inline createClaudeSDKAgent() (services/claudeSdkAgent.ts)
 * which is a thin wrapper over @anthropic-ai/claude-agent-sdk providing:
 * - Full tool support (Read, Write, Edit, Bash, Glob, Grep, WebSearch, etc.)
 * - System prompt from CLAUDE.md
 * - Extended thinking (16k budget)
 * - bypassPermissions mode
 * - Model resolution (aliases → full IDs)
 */
async function invokeViaClaudeAgentSDK(
  prompt: string,
  model?: string,
  workspacePath?: string,
  context?: { parentRunId?: string; jobId?: string; userId?: string; s3Bucket?: string; s3Prefix?: string; stepNumber?: string; skill?: string; workingDir?: string; outputSchema?: Record<string, unknown>; toolHarness?: 'pi' | 'claude_sdk' },
): Promise<InvocationResult> {
  const resolvedModel = resolveModelId(model);
  const workspaceRoot = workspacePath || process.cwd();
  const cwd = context?.workingDir ? join(workspaceRoot, context.workingDir) : workspaceRoot;

  // BYOK: look up the user's saved credential for the relevant provider.
  // SDK path uses ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN for
  // Claude Max subscribers) for direct Anthropic, ANTHROPIC_AUTH_TOKEN
  // for OpenRouter via the Anthropic Skin. Workers fetch the plaintext
  // from orion over an authenticated internal endpoint; the credential
  // is used for this invocation only and never persisted.
  // For Anthropic, OAuth (Claude Max) wins over an API key when both
  // are saved — Max users almost always want subscription billing.
  const isOpenRouterModelForByok = !!resolvedModel && resolvedModel.includes('/');
  let byokKey: string | null = null;
  let byokOAuth: string | null = null;
  if (context?.userId) {
    if (isOpenRouterModelForByok) {
      byokKey = await fetchUserProviderKey(context.userId, 'openrouter');
    } else {
      byokOAuth = await fetchUserProviderKey(context.userId, 'anthropic_oauth');
      if (!byokOAuth) {
        byokKey = await fetchUserProviderKey(context.userId, 'anthropic');
      }
    }
  }
  if (byokOAuth) {
    console.log('[invokeViaClaudeAgentSDK] using BYOK Anthropic OAuth (Claude Max)', { userId: context?.userId });
  } else if (byokKey) {
    console.log('[invokeViaClaudeAgentSDK] using BYOK key', {
      userId: context?.userId,
      provider: isOpenRouterModelForByok ? 'openrouter' : 'anthropic',
    });
  }
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
      outputFormat: context?.outputSchema
        ? { type: 'json_schema', schema: context.outputSchema }
        : undefined,
      env: (() => {
        // LiteLLM is the always-on model transport. The Claude Agent SDK
        // speaks Anthropic protocol to the proxy; the proxy translates to
        // whatever the model_name resolves to in its model_list (Anthropic,
        // OpenRouter, Kimi, Gemini, etc.). This collapses the previous
        // per-provider branching (OpenRouter slug path, agentBackendVia
        // toggle, BYOK env juggling) into one path.
        //
        // Auth ladder:
        //   1. proxy <- LITELLM_MASTER_KEY (proxy admin auth)
        //   2. upstream <- whatever model_list entry's api_key resolves to
        //      (env-substituted per provider in the LiteLLM config)
        //   BYOK passthrough for the SDK path is a follow-up — the SDK
        //   doesn't expose extra_body, so user keys can't ride the request
        //   today. Until then, users on this path share the deploy's
        //   upstream credentials. The chat-mode path (litellmProvider.ts)
        //   does forward BYOK via body.api_key.
        const out: Record<string, string> = { ...(process.env as Record<string, string>) };
        const proxyUrl = (process.env.LITELLM_PROXY_URL || '').replace(/\/+$/, '');
        const masterKey = process.env.LITELLM_MASTER_KEY || '';

        // Anthropic-native models (claude-*) bypass LiteLLM and talk to
        // api.anthropic.com directly. The cluster carries a Claude Max
        // OAuth token (CLAUDE_CODE_OAUTH_TOKEN, sk-ant-oat01-…) — routing
        // those calls through LiteLLM would force its model_list entries
        // to use a metered ANTHROPIC_API_KEY (silent downgrade off the
        // subscription) AND LiteLLM doesn't currently forward sk-ant-oat
        // tokens. So for claude-* we keep the SDK pointed at Anthropic
        // and let it use OAuth (or BYOK). Non-Anthropic models still go
        // through LiteLLM, which is where the gateway adds value.
        const isAnthropicModel = !!resolvedModel && /^claude[-_]/i.test(resolvedModel);

        if (proxyUrl && masterKey && !isAnthropicModel) {
          out.ANTHROPIC_BASE_URL = proxyUrl;
          out.ANTHROPIC_AUTH_TOKEN = masterKey;
          out.ANTHROPIC_API_KEY = '';
          delete out.CLAUDE_CODE_OAUTH_TOKEN;
          console.log('[invokeViaClaudeAgentSDK] routing via LiteLLM proxy', {
            proxyUrl, model: resolvedModel, userId: context?.userId,
          });
        } else if (isAnthropicModel) {
          // Direct-to-Anthropic with OAuth (Claude Max) or BYOK.
          if (byokOAuth) {
            out.CLAUDE_CODE_OAUTH_TOKEN = byokOAuth;
            out.ANTHROPIC_API_KEY = '';
          } else if (byokKey) {
            out.ANTHROPIC_API_KEY = byokKey;
            delete out.CLAUDE_CODE_OAUTH_TOKEN;
          } else {
            // Deploy default: prefer the OAuth token; only fall back to a
            // metered API key if no OAuth is configured.
            const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (oauth) {
              out.CLAUDE_CODE_OAUTH_TOKEN = oauth;
              out.ANTHROPIC_API_KEY = '';
            } else if (apiKey && apiKey.trim()) {
              out.ANTHROPIC_API_KEY = apiKey;
              delete out.CLAUDE_CODE_OAUTH_TOKEN;
            }
          }
          // Make sure we're NOT pointed at LiteLLM for this call.
          delete out.ANTHROPIC_BASE_URL;
          delete out.ANTHROPIC_AUTH_TOKEN;
          console.log('[invokeViaClaudeAgentSDK] direct to api.anthropic.com', {
            model: resolvedModel,
            auth: out.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth' : (out.ANTHROPIC_API_KEY ? 'api_key' : 'none'),
            userId: context?.userId,
          });
        } else {
          // Deploy missing LiteLLM config — fall back to the historical
          // direct-to-Anthropic path so the call still goes through. Loud
          // warn so the misconfiguration is visible in pod logs.
          console.warn(
            '[invokeViaClaudeAgentSDK] LITELLM_PROXY_URL/LITELLM_MASTER_KEY missing — falling back to direct provider auth (BYOK or env)',
            { proxyUrlSet: !!proxyUrl, masterKeySet: !!masterKey, userId: context?.userId },
          );
          const isOpenRouterModel = !!resolvedModel && resolvedModel.includes('/');
          if (isOpenRouterModel) {
            const orKey = byokKey || process.env.OPENROUTER_API_KEY?.trim();
            if (orKey) {
              out.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
              out.ANTHROPIC_AUTH_TOKEN = orKey;
              out.ANTHROPIC_API_KEY = '';
              delete out.CLAUDE_CODE_OAUTH_TOKEN;
            }
          } else if (byokOAuth) {
            out.CLAUDE_CODE_OAUTH_TOKEN = byokOAuth;
            out.ANTHROPIC_API_KEY = '';
          } else if (byokKey) {
            out.ANTHROPIC_API_KEY = byokKey;
            delete out.CLAUDE_CODE_OAUTH_TOKEN;
          } else {
            const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (oauth && (!apiKey || !apiKey.trim())) {
              delete out.ANTHROPIC_API_KEY;
              out.CLAUDE_CODE_OAUTH_TOKEN = oauth;
            }
          }
        }
        return out;
      })(),
    });

    let stdout = '';
    let structuredOutput: unknown = undefined;
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
        if (event.subtype === 'success' && (event as any).structured_output !== undefined) {
          structuredOutput = (event as any).structured_output;
        }

        const norm = normalizeUsage((event as any).usage);
        if (norm) {
          const tokenPayload = {
            backend: 'claude-agent-sdk',
            model: resolvedModel,
            ...norm,
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
        // Safety refusal: the API returns 200 with stop_reason='refusal' when
        // Claude declines for safety reasons. Per the Structured Outputs docs,
        // refusals override the schema constraint, so structured_output may be
        // missing or non-conformant. Surface as a distinct error rather than
        // letting an empty/garbage payload pass through to executeStep.
        if (event.stop_reason === 'refusal') {
          const msg = 'Model refused the request for safety reasons (stop_reason=refusal). Schema enforcement is bypassed in this case; output may not match the declared schema.';
          console.error('[invokeViaClaudeAgentSDK] refusal:', msg);
          return {
            success: false,
            stdout,
            stderr: msg,
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

    return { success: true, stdout, stderr: '', exitCode: 0, structuredOutput };
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
 * Decide whether a model id should route through Claude Agent SDK or
 * the harness/Pi path. Mirrors orion's split: Anthropic models stay on
 * the SDK (real OAuth + cache + workspace context), everything else
 * goes through Pi/LiteLLM. The shape we look at is the model id —
 * `claude-*` is Anthropic-direct; vendor/slug or non-claude bare ids
 * are non-Anthropic.
 *
 * Used only when AGENT_BACKEND='auto'.
 */
function pickBackendByModel(model?: string): 'harness' | 'claude-agent-sdk' {
  const id = (model || '').trim();
  if (!id) return 'claude-agent-sdk';   // unspecified → default to SDK
  // Vendor-prefixed slug → non-Anthropic upstream → harness/Pi.
  if (id.includes('/')) return 'harness';
  // Bare Anthropic id (claude-opus-4-7, claude-sonnet-4-5-20250929,
  // claude-haiku-4-5, etc.) → SDK.
  if (id.startsWith('claude-')) return 'claude-agent-sdk';
  // Anything else (gpt-*, gemini-*, kimi-*, ...) → harness/Pi.
  return 'harness';
}

/**
 * Extract the `mode` value from a Step's Inputs or Notes column.
 *
 * Inputs convention (e.g. p-jpm-retry-lens): a token "mode=<value>" in step.inputs[].
 * Notes convention (used by p-jpm-eval/feedback/revise/chair): a substring "mode=<value>"
 *   inside step.notes, separated by whitespace/comma/semicolon (or at string start).
 *
 * Inputs wins on tie. Returns undefined when neither is present, or when the value
 * uses unresolved template-var syntax like `mode={{MODE}}` (the character class
 * [A-Za-z0-9_]+ matches literal mode tokens only). The {{MODE}}-style retry path
 * is fixed via PR B SOP cleanup (standardize to literal mode tokens).
 *
 * Exported for unit testing — production callers should use it via the inline
 * call in invokeSkill().
 */
export function extractStepMode(step: { inputs?: string[]; notes?: string }): string | undefined {
  const modeFromInputs = step.inputs?.find(i => i.startsWith('mode='))?.split('=')[1];
  const modeFromNotes = step.notes?.match(/(?:^|[\s,;])mode=([A-Za-z0-9_]+)/)?.[1];
  return modeFromInputs || modeFromNotes || undefined;
}

/**
 * Invoke a skill using the specified or configured backend.
 *
 * Backend selection priority:
 * 1. Per-request agentBackend parameter (from workflow input)
 * 2. AGENT_BACKEND env var — 'auto' | 'harness' | 'claude-agent-sdk' | 'claude-cli'
 *
 * `auto` is the orion-style split: Anthropic models go to the Claude
 * Agent SDK, everything else goes to invokeViaHarness (which itself
 * routes through Pi + LiteLLM when those flags are on).
 */
export async function invokeSkill(
  step: Step,
  prompt: string,
  workspacePath?: string,
  agentBackend?: AgentBackend,
  context?: { parentRunId?: string; jobId?: string; userId?: string; s3Bucket?: string; s3Prefix?: string; workingDir?: string; toolHarness?: 'pi' | 'claude_sdk' },
): Promise<InvocationResult> {
  // toolHarness overrides the legacy `agentBackend` param when set.
  // Orion resolves the user's `User.toolHarness` (auto/pi/claude_sdk) +
  // reasoning provider into a concrete 'pi' | 'claude_sdk' before calling
  // svc-temporal, so by the time we land here it's a hard choice.
  const harness = context?.toolHarness;
  let backend: AgentBackend;
  if (harness === 'pi') {
    backend = 'harness';
  } else if (harness === 'claude_sdk') {
    backend = 'claude-agent-sdk';
  } else {
    const requestedBackend = agentBackend || AGENT_BACKEND;
    backend = requestedBackend === 'auto'
      ? pickBackendByModel(step.model)
      : requestedBackend;
  }
  // Surface where the backend choice came from: explicit toolHarness wins,
  // else legacy auto/agentBackend resolution applied.
  const choiceSource = harness
    ? `toolHarness=${harness}`
    : (agentBackend || AGENT_BACKEND) === 'auto' ? 'auto' : 'agentBackend';
  console.log(
    `[invokeSkill] backend=${backend} (${choiceSource}), ` +
    `skill=${step.skill}, model=${step.model || 'default'}, parentRunId=${context?.parentRunId || ''}`,
  );

  // Thread step identity into the inner invocation so the harness/SDK paths can
  // stamp `stepNumber` + `skill` onto the `token_update` event they emit from
  // the final `result`. Without this, per-step spend can't be attributed on
  // the UI side.
  //
  // For SDK-backed Anthropic invocations only, also look up the leaf skill's
  // output_schema_path frontmatter and thread it through as `outputSchema`.
  // When present, the SDK enforces it via Structured Outputs (constrained
  // decoding) and returns the validated payload in InvocationResult.
  // Other backends (Pi, subprocess) silently ignore it for now.
  // Schema load happens regardless of backend so we can detect mis-routing.
  // We only THREAD the schema into the SDK path (the only path that can enforce
  // it). For Pi/subprocess paths we log loudly so silent enforcement loss is
  // visible — the most common cause is a user-level delegate model override
  // pointing schema-bearing skills at a non-Anthropic upstream.
  // Pass mode (when present) so the loader can dispatch on output_schemas (plural).
  // See extractStepMode() above for the Inputs vs Notes conventions.
  const mode = extractStepMode(step);
  const leafSchema = loadLeafSkillSchema(step.skill, mode);
  if (leafSchema && backend === 'claude-agent-sdk') {
    console.log(`[invokeSkill] schema loaded for skill='${step.skill}' from ${leafSchema.schemaPath}`);
  } else if (leafSchema) {
    console.warn(
      `[invokeSkill] WARNING: skill='${step.skill}' declares output_schema_path ` +
      `(${leafSchema.schemaPath}) but is dispatched on backend='${backend}' which ` +
      `does NOT support Anthropic Structured Outputs. Schema will NOT be enforced — ` +
      `model output may drift. Re-route to a claude-* model to enable enforcement.`,
    );
  }
  const innerContext: any = { ...(context || {}), stepNumber: step.number, skill: step.skill };
  if (leafSchema && backend === 'claude-agent-sdk') innerContext.outputSchema = leafSchema.schema;

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
