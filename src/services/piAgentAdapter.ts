/**
 * Pi (pi-agent-core) → harness-shaped event adapter.
 *
 * Phase 2 of docs/agent-routing-architecture.md. Behind USE_PI_AGENT
 * flag. When enabled, the non-Anthropic reasoning path uses
 * @mariozechner/pi-agent-core instead of @tne-ai/agent-harness.
 *
 * The adapter exists because:
 *   - Pi's event protocol differs from the harness (subscribe callback vs
 *     async iterator; tool_execution_start/end vs assistant content blocks).
 *   - agentService.ts's existing `for await` loop expects harness-shaped
 *     events: assistant, tool_result, partial_message, result.
 *   - Translating at the adapter boundary avoids touching the consumer
 *     loop, so the flag is a clean swap.
 *
 * Phase 2.5 features (this file):
 *   - PiAgentSession owns a single Pi Agent instance reused across queries
 *     for conversation continuity within a chat (each prompt continues
 *     from the prior transcript).
 *   - Harness-format hooks (PreToolUse / PostToolUse with matcher regex)
 *     translated to Pi's beforeToolCall / afterToolCall callbacks.
 *
 * Known gaps still:
 *   - No CLAUDE.md auto-ingestion (caller injects via systemPrompt)
 *   - No skills loader (would need to scan .claude/skills and inline)
 *   - No subagent dispatch (Task tool absent)
 *   - No permission modes (everything is bypassPermissions-equivalent)
 */

import { Agent, type AgentTool, type AgentEvent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';

// svc-temporal doesn't have orion's structured Logger module — use a
// console-prefixed shim with the same surface so the ported code below
// reads identically. Single-line swap if/when a real logger lands.
const log = {
  info: (msg: string, meta?: any) => console.log(`[PiAgentAdapter] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: any) => console.warn(`[PiAgentAdapter] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: any) => console.error(`[PiAgentAdapter] ${msg}`, meta ?? ''),
};

// ── Hook types — match the harness's existing `hooks: {...}` shape ─────────

/**
 * Single hook function. Called with the harness-style payload:
 *   { tool_name, tool_input, tool_use_id }
 * Returns:
 *   - undefined / void → no change
 *   - { continue: false, ... } → block the tool call (PreToolUse only)
 *   - other → ignored (we don't currently support input rewriting)
 */
export type HarnessHookFn = (
  input: { tool_name: string; tool_input: any; tool_use_id?: string },
  toolUseId?: string,
  options?: { signal?: AbortSignal },
) => Promise<any> | any;

export interface HarnessHookEntry {
  /** Regex-style matcher applied to tool name. e.g. 'Write|Edit|Read'. */
  matcher: string;
  hooks: HarnessHookFn[];
}

export interface HarnessHooks {
  PreToolUse?: HarnessHookEntry[];
  PostToolUse?: HarnessHookEntry[];
}

// ── Adapter options ────────────────────────────────────────────────────────

export interface PiAgentOptions {
  apiType: 'anthropic-messages' | 'openai-completions';
  model: string;
  apiKey: string;
  baseURL?: string;
  /** Workspace root used for tool path scoping. Caller supplies tools that respect this. */
  cwd: string;
  systemPrompt: string;
  /** Tools to register with the Pi agent. See piAgentTools.ts for defaults. */
  tools: AgentTool<any>[];
  maxTokens?: number;
  abortController?: AbortController;
  /** Provider hint for getApiKey resolution. */
  provider?: string;
  /** Harness-format hook config. Translated to Pi callbacks. */
  hooks?: HarnessHooks;
}

/**
 * Harness-compatible event shape. Mirrors the subset of @tne-ai/agent-harness
 * events that agentService.ts actually inspects in its for-await loop.
 */
export type HarnessEvent =
  | { type: 'assistant'; message: { content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: any }> } }
  | { type: 'tool_result'; result: { tool_use_id: string; tool_name: string; output: string; is_error?: boolean } }
  | { type: 'partial_message'; delta: { text: string } }
  | { type: 'result'; subtype?: string; is_error?: boolean; num_turns?: number };

/**
 * Build a Pi Model object from our flat options. Pi expects a fully-formed
 * Model<TApi> with cost / context / token caps. For OpenRouter we don't
 * actually know those numbers per upstream — set sane defaults; the agent
 * loop only uses contextWindow and maxTokens for budgeting hints.
 */
function buildPiModel(opts: PiAgentOptions): Model<any> {
  return {
    id: opts.model,
    name: opts.model,
    api: opts.apiType,
    provider: opts.provider || (opts.baseURL?.includes('openrouter') ? 'openrouter' : 'anthropic'),
    baseUrl: opts.baseURL || (opts.apiType === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: opts.maxTokens ?? 16384,
  };
}

/**
 * Bounded async queue with promise-based wakeup. Used to bridge Pi's
 * subscribe callback into an async iterator. Avoids dropping events
 * by buffering up to a limit; callers should drain via `next()`.
 */
class EventQueue<T> {
  private queue: T[] = [];
  private waiters: Array<(v: T | { done: true }) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w(item);
    else this.queue.push(item);
  }

  close() {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ done: true });
    }
  }

  async next(): Promise<T | { done: true }> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return { done: true };
    return new Promise<T | { done: true }>((resolve) => this.waiters.push(resolve));
  }
}

function isDoneSignal<T>(v: T | { done: true }): v is { done: true } {
  return typeof v === 'object' && v !== null && (v as any).done === true;
}

/**
 * Translate Pi's event stream into harness-shaped events.
 *
 * Pi emits granular events; the harness emits coarser ones. The translation
 * rules:
 *   - Pi `message_update` with assistantMessageEvent.type === 'text_delta'
 *     → harness `partial_message` with { delta: { text } }
 *   - Pi `tool_execution_start` → harness `assistant` carrying a single
 *     tool_use content block (consumer treats this as "agent is calling X")
 *   - Pi `tool_execution_end` → harness `tool_result`
 *   - Pi `agent_end` → harness `result`
 *
 * Other Pi events (agent_start, turn_start, turn_end, message_start,
 * message_end) are internal-only and not surfaced; the consumer doesn't
 * branch on them.
 */
function translatePiEvent(event: AgentEvent): HarnessEvent[] {
  switch (event.type) {
    case 'message_update': {
      const inner = event.assistantMessageEvent as any;
      if (inner?.type === 'text_delta' && typeof inner.delta === 'string' && inner.delta.length > 0) {
        return [{ type: 'partial_message', delta: { text: inner.delta } }];
      }
      return [];
    }
    case 'tool_execution_start': {
      return [{
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: event.toolCallId,
            name: event.toolName,
            input: event.args,
          }],
        },
      }];
    }
    case 'tool_execution_end': {
      const text = extractToolResultText(event.result);
      return [{
        type: 'tool_result',
        result: {
          tool_use_id: event.toolCallId,
          tool_name: event.toolName,
          output: text,
          is_error: event.isError,
        },
      }];
    }
    case 'agent_end': {
      return [{ type: 'result' }];
    }
    default:
      return [];
  }
}

function extractToolResultText(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}

/**
 * Reduce a raw Pi/LiteLLM error into a single user-readable line. Errors
 * arrive in many shapes:
 *   - LiteLLM rate-limit: stringified JSON inside an Error wrapped in another
 *     Error, with a `message` field containing the upstream's full payload
 *     (Gemini's "RESOURCE_EXHAUSTED" body, retry hint, etc.)
 *   - Network / DNS errors: plain Error with cause
 *   - Pi's own errors: { name, message }
 *
 * We extract the most useful prose we can find. The user gets one line of
 * actionable info instead of a blank chat. Full details still go to the
 * structured logs via log.error.
 */
function summariseUpstreamError(err: any): string {
  const raw = err?.message ?? String(err ?? '');

  // LiteLLM rate-limit: look for "Please retry in N seconds" — actionable.
  const retryMatch = raw.match(/Please retry in ([0-9.]+)\s*s/i);
  if (/RateLimitError|429|RESOURCE_EXHAUSTED/i.test(raw)) {
    const retry = retryMatch ? ` Retry in ${Math.ceil(parseFloat(retryMatch[1]))}s.` : '';
    const quotaMatch = raw.match(/limit:\s*([0-9]+),\s*model:\s*([\w.-]+)/i);
    const quota = quotaMatch ? ` (limit ${quotaMatch[1]} req/min on ${quotaMatch[2]})` : '';
    return `**Rate limited by upstream.**${quota}${retry}`;
  }

  // Auth failures.
  if (/AuthenticationError|invalid.*api.*key|401/i.test(raw)) {
    return '**Authentication failed at the LLM gateway.** Check that the upstream provider key is valid.';
  }

  // Bad model id from LiteLLM — usually a config drift.
  const invalidMatch = raw.match(/invalid model ID.*Received Model Group=([\w.\-/]+)/i);
  if (invalidMatch) {
    return `**Model "${invalidMatch[1]}" is not configured in the LiteLLM proxy.** Add it to litellm/config.template.yaml.`;
  }

  // Network / fetch failures.
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) {
    return '**Could not reach the LLM gateway.** Check that the litellm sidecar is running and LITELLM_PROXY_URL is set correctly.';
  }

  // Fallback — first line of the raw message, capped.
  const firstLine = raw.split('\n').find((l: string) => l.trim()) ?? 'Unknown error';
  return `**Upstream error.** ${firstLine.slice(0, 240)}`;
}

/**
 * Compile a list of harness hook entries into a single Pi-compatible
 * callback that:
 *   1. matches each entry's matcher regex against the current tool name,
 *   2. invokes every matching hook in order, awaiting each,
 *   3. returns the first explicit `{ continue: false }` as a Pi block
 *      (PreToolUse only — PostToolUse runs after execution and can't
 *      block).
 *
 * The matcher syntax matches the harness convention: a string treated as
 * a regex. Bare names like `Bash` work because they're literal regex.
 * Pipe-separated names like `Write|Edit|Read` match any of the three.
 */
function compileBeforeHook(entries: HarnessHookEntry[] | undefined): ((ctx: any, signal?: AbortSignal) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined {
  if (!entries || entries.length === 0) return undefined;
  return async (ctx, signal) => {
    const toolName: string = ctx.toolCall?.name ?? '';
    const args: any = ctx.toolCall?.args ?? ctx.args ?? {};
    const toolUseId: string = ctx.toolCall?.id ?? '';
    for (const entry of entries) {
      let matches = false;
      try { matches = new RegExp(entry.matcher).test(toolName); }
      catch { matches = entry.matcher === toolName; }
      if (!matches) continue;
      for (const fn of entry.hooks) {
        try {
          const result = await fn(
            { tool_name: toolName, tool_input: args, tool_use_id: toolUseId },
            toolUseId,
            { signal },
          );
          if (result && typeof result === 'object' && result.continue === false) {
            return { block: true, reason: result.reason || result.stopReason || 'Blocked by PreToolUse hook' };
          }
        } catch (err: any) {
          log.warn('PreToolUse hook threw — continuing without blocking', { tool: toolName, err: err?.message });
        }
      }
    }
    return undefined;
  };
}

function compileAfterHook(entries: HarnessHookEntry[] | undefined): ((ctx: any, signal?: AbortSignal) => Promise<undefined>) | undefined {
  if (!entries || entries.length === 0) return undefined;
  return async (ctx, signal) => {
    const toolName: string = ctx.toolCall?.name ?? '';
    const args: any = ctx.toolCall?.args ?? ctx.args ?? {};
    const toolUseId: string = ctx.toolCall?.id ?? '';
    const result: any = ctx.result;
    for (const entry of entries) {
      let matches = false;
      try { matches = new RegExp(entry.matcher).test(toolName); }
      catch { matches = entry.matcher === toolName; }
      if (!matches) continue;
      for (const fn of entry.hooks) {
        try {
          await fn(
            { tool_name: toolName, tool_input: args, tool_use_id: toolUseId, ...(result !== undefined ? { tool_result: result } : {}) } as any,
            toolUseId,
            { signal },
          );
        } catch (err: any) {
          log.warn('PostToolUse hook threw — continuing', { tool: toolName, err: err?.message });
        }
      }
    }
    return undefined;
  };
}

// ── Session API ────────────────────────────────────────────────────────────

/**
 * Sessionised Pi agent — owns a single Pi Agent across multiple queries
 * to preserve conversation continuity. agentService.ts stores one of these
 * in `session.agentInstance` so subsequent prompts continue the transcript.
 */
export class PiAgentSession {
  private agent: Agent;
  /** External abort wired in at construction time. */
  private externalAbort?: AbortController;
  private abortListener?: () => void;

  constructor(opts: PiAgentOptions) {
    const model = buildPiModel(opts);
    const beforeToolCall = compileBeforeHook(opts.hooks?.PreToolUse);
    const afterToolCall = compileAfterHook(opts.hooks?.PostToolUse);

    this.agent = new Agent({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model,
        tools: opts.tools,
        messages: [],
        thinkingLevel: 'off',
      },
      convertToLlm: (msgs) => msgs as any,
      toolExecution: 'parallel',
      getApiKey: async () => opts.apiKey,
      ...(beforeToolCall ? { beforeToolCall } : {}),
      ...(afterToolCall ? { afterToolCall } : {}),
    });

    if (opts.abortController) {
      this.externalAbort = opts.abortController;
      this.abortListener = () => {
        log.info('Pi session aborted via external AbortController');
        this.agent.abort();
      };
      opts.abortController.signal.addEventListener('abort', this.abortListener);
    }
  }

  /**
   * Run a single prompt and yield harness-shaped events. The Pi Agent's
   * transcript persists between calls — this is what makes session
   * continuity work without rebuilding state on every query.
   *
   * Per-query abort wiring: the session-level listener (set in the
   * constructor) propagates an external abort to `agent.abort()`. The
   * per-query listener installed here ALSO closes the query's local
   * event queue so the async generator terminates promptly instead of
   * blocking on an event that will never arrive (Pi may not always
   * emit `agent_end` after an aborted run).
   */
  async *query(prompt: string): AsyncGenerator<HarnessEvent, void, unknown> {
    const queue = new EventQueue<HarnessEvent>();

    const unsubscribe = this.agent.subscribe((event) => {
      for (const translated of translatePiEvent(event)) {
        queue.push(translated);
      }
      if (event.type === 'agent_end') {
        queue.close();
      }
    });

    const onQueryAbort = () => queue.close();
    this.externalAbort?.signal.addEventListener('abort', onQueryAbort);

    this.agent.prompt(prompt).catch((err) => {
      // Without surfacing the message the consumer's chat UI shows a blank
      // turn — what the user sees when e.g. Gemini rate-limits the request.
      // Emit the error text as an assistant text block FIRST so it renders
      // in the conversation, then the result event so the loop terminates.
      log.error('Pi agent.prompt() rejected', err);
      const summary = summariseUpstreamError(err);
      queue.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: summary }] },
      });
      queue.push({ type: 'result', subtype: 'error', is_error: true });
      queue.close();
    });

    try {
      while (true) {
        const item = await queue.next();
        if (isDoneSignal(item)) return;
        yield item;
      }
    } finally {
      unsubscribe();
      this.externalAbort?.signal.removeEventListener('abort', onQueryAbort);
    }
  }

  /**
   * Disposal — call when the session is being torn down. Detaches the
   * external abort listener and aborts any in-flight run.
   */
  dispose(): void {
    if (this.externalAbort && this.abortListener) {
      this.externalAbort.signal.removeEventListener('abort', this.abortListener);
    }
    try { this.agent.abort(); } catch { /* idempotent */ }
  }
}

/**
 * Convenience: run a single prompt without owning a long-lived session.
 * Equivalent to creating a PiAgentSession, running one query, and disposing.
 *
 * Used by callers that don't have a session concept (the test suite,
 * one-shot integrations). Sessionised consumers should use PiAgentSession
 * directly.
 */
export async function* queryWithPi(
  prompt: string,
  options: PiAgentOptions,
): AsyncGenerator<HarnessEvent, void, unknown> {
  const session = new PiAgentSession(options);
  try {
    yield* session.query(prompt);
  } finally {
    session.dispose();
  }
}

/** True when USE_PI_AGENT env flag is on. Read per-call so test fixtures can flip it. */
export function isPiAgentEnabled(): boolean {
  const v = (process.env.USE_PI_AGENT || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** True when USE_LITELLM_PROXY env flag is on — same surface as orion. */
export function isLiteLLMProxyEnabled(): boolean {
  const v = (process.env.USE_LITELLM_PROXY || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Build the LiteLLM v1 base URL from LITELLM_PROXY_URL with a sane default. */
export function getLiteLLMBaseURL(): string {
  const raw = process.env.LITELLM_PROXY_URL || 'http://litellm:4000';
  return `${raw.replace(/\/+$/, '')}/v1`;
}

/**
 * Normalize a model id into the alias the LiteLLM proxy's model_list
 * recognises. Shared by every code path that targets LiteLLM (Pi adapter,
 * harness path in agentService.ts, the LLMRouter's LiteLLMProvider).
 *
 * Conventions (mirror litellm/config.template.yaml):
 *   - Bare model id (gpt-4o-mini, gemini-2.0-flash, claude-sonnet-4-5)
 *     passes through unchanged — LiteLLM has explicit entries for these.
 *   - Vendor-prefixed slug (anthropic/claude-sonnet-4-5) — strip the
 *     vendor when the upstream provider is direct (anthropic/openai/gemini),
 *     OR translate to a flat or-* alias when the upstream is openrouter
 *     because slashed model_names collide with LiteLLM's prefix parser.
 *   - or-* aliases pass through unchanged.
 *
 * The provider hint disambiguates: `anthropic/claude-sonnet-4-5` could
 * mean "Anthropic-direct via the SDK" (strip prefix) or "Anthropic via
 * OpenRouter" (translate to or-claude-sonnet-4-5).
 */
export function normalizeModelForLitellm(provider: string, model: string): string {
  if (model.startsWith('or-')) return model;
  if (provider === 'openrouter') {
    const lastSlash = model.lastIndexOf('/');
    const tail = lastSlash >= 0 ? model.slice(lastSlash + 1) : model;
    return `or-${tail}`;
  }
  // Direct providers (anthropic / openai / google / gemini): strip any
  // vendor prefix so the bare id matches LiteLLM's flat config aliases.
  const lastSlash = model.lastIndexOf('/');
  return lastSlash >= 0 ? model.slice(lastSlash + 1) : model;
}
