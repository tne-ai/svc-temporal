/**
 * Inline replacement for the parts of @tne-ai/agent-harness that
 * svc-temporal actually used:
 *
 *   - `resolveModelId`         — alias → full Anthropic model ID
 *   - `createClaudeSDKAgent()` — config sugar over @anthropic-ai/claude-agent-sdk
 *
 * The harness package is being retired. Rather than keep a one-package
 * dependency for ~150 lines of config, we inline what we need here. The
 * shape of events yielded by `query()` is unchanged: it's still the
 * native Claude Agent SDK event stream.
 *
 * For non-Anthropic upstreams (OpenRouter etc.) we don't go through
 * this file at all — that path uses Pi (@mariozechner/pi-agent-core)
 * directly, see piAgentAdapter.ts.
 */

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

// ── Model ID resolution ───────────────────────────────────────────────────

/** Anthropic alias → full model ID. Mirrors what the harness shipped. */
const ANTHROPIC_MODELS: Record<string, string> = {
  sonnet:                 'claude-sonnet-4-20250514',
  opus:                   'claude-opus-4-20250514',
  haiku:                  'claude-haiku-4-5-20251001',
  'sonnet-4':             'claude-sonnet-4-20250514',
  'opus-4':               'claude-opus-4-20250514',
  'haiku-4':              'claude-haiku-4-5-20251001',
  'sonnet-4.5':           'claude-sonnet-4-5-20250929',
  'sonnet-4-5':           'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6':    'claude-sonnet-4-20250514',
  'claude-opus-4-6':      'claude-opus-4-20250514',
  'claude-haiku-4-5':     'claude-haiku-4-5-20251001',
};

const DEFAULT_AGENT_MODEL = process.env.DEFAULT_AGENT_MODEL || 'claude-sonnet-4-20250514';

/**
 * Resolve a model alias or short ID to a full Anthropic model ID.
 * - Pass-through for OpenRouter slugs (vendor/model) and full date-suffixed IDs.
 * - Maps known aliases.
 * - Falls back to the default agent model on null/undefined.
 */
export function resolveModelId(model: string | undefined): string {
  if (!model) return DEFAULT_AGENT_MODEL;
  if (model.includes('/')) return model;
  if (model.startsWith('claude-') && /\d{8}$/.test(model)) return model;
  return ANTHROPIC_MODELS[model] || model;
}

// ── CLAUDE.md system prompt (cached) ──────────────────────────────────────

let cachedSystemPrompt: string | null = null;

function findClaudeMd(cwd?: string): string | null {
  const paths: string[] = [];
  if (cwd) {
    paths.push(join(cwd, '.claude', 'CLAUDE.md'));
    paths.push(join(cwd, 'tne-plugins', 'data', 'CLAUDE.md'));
    paths.push(join(cwd, '..', 'tne-plugins', 'data', 'CLAUDE.md'));
  }
  paths.push(
    join(process.cwd(), '..', 'tne-plugins', 'data', 'CLAUDE.md'),
    join(process.cwd(), 'tne-plugins', 'data', 'CLAUDE.md'),
    '/app/tne-plugins/data/CLAUDE.md',
  );
  for (const p of paths) {
    try { if (existsSync(p)) return readFileSync(p, 'utf-8'); } catch { /* ignore */ }
  }
  return null;
}

function getSystemPrompt(cwd?: string): string {
  if (cachedSystemPrompt) return appendDateTime(cachedSystemPrompt);
  const content = findClaudeMd(cwd);
  let prompt: string;
  if (content) {
    prompt = content.trim()
      + '\n\n## Response Formatting Override\n'
      + 'Do NOT prefix responses with [TNE CONTEXT: ...] status tags. '
      + 'Skip any "Status Prefix" instructions from above. '
      + 'Respond naturally without status headers.'
      + '\n\n## Skill Invocation Protocol\n'
      + 'When the user\'s message includes a `<skill>` tag, follow the skill instructions exactly. '
      + 'Do NOT guess or hallucinate capabilities beyond what the skill defines.';
  } else {
    prompt = 'You are Compass, a highly skilled software engineer and business analyst. '
      + 'You help with software development, research, and task planning.';
  }
  cachedSystemPrompt = prompt;
  return appendDateTime(prompt);
}

function appendDateTime(prompt: string): string {
  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `${prompt}\n\nCurrent date and time: ${day}, ${dateStr} UTC`;
}

// ── Workspace prompt wrapper ──────────────────────────────────────────────

const AGENT_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Skill',
] as const;

function wrapPrompt(prompt: string, opts?: { workspacePath?: string; workingDirectory?: string }): string {
  const parts: string[] = [
    'You are working in a persistent workspace.',
    'All file operations use your current directory. Write files using relative paths.',
  ];
  if (opts?.workingDirectory && opts?.workspacePath) {
    parts.push(`The full workspace root is: ${opts.workspacePath} — you may read/search files there ONLY if the user explicitly asks.`);
  }
  parts.push('When creating large documents (>10KB), write incrementally: create the structure first, then Edit to append sections. Save frequently.');
  parts.push(`\nUser request: ${prompt}`);
  return parts.join('\n');
}

// ── Claude executable detection ───────────────────────────────────────────

function findClaudeExecutable(): string | undefined {
  const common = [
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.claude/local/claude`,
    '/usr/local/bin/claude',
  ];
  for (const p of common) { try { if (existsSync(p)) return p; } catch { /* ignore */ } }
  try { return execSync('which claude', { encoding: 'utf-8' }).trim() || undefined; } catch { return undefined; }
}

// ── Agent factory ─────────────────────────────────────────────────────────

export interface JsonSchemaOutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

export interface ClaudeSDKAgentOptions {
  model?: string;
  cwd?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  maxTurns?: number;
  maxThinkingTokens?: number;
  wrapPrompt?: boolean;
  workspacePath?: string;
  workingDirectory?: string;
  hooks?: Record<string, any[]>;
  env?: Record<string, string | undefined>;
  abortController?: AbortController;
  persistSession?: boolean;
  pathToClaudeCodeExecutable?: string;
  allowedTools?: readonly string[];
  /**
   * Constrain the agent's final response to match a JSON Schema. The SDK
   * forwards this to Anthropic's Structured Outputs feature, which uses
   * grammar-constrained sampling — the final response is guaranteed to
   * be valid JSON matching the schema. Surfaces on the SDK's result event
   * as `structured_output`. Anthropic-direct only; ignored on non-SDK paths.
   */
  outputFormat?: JsonSchemaOutputFormat;
}

export interface ClaudeSDKAgent {
  query(prompt: string): AsyncGenerator<any, void>;
}

/**
 * Build a Claude Agent SDK agent with the same execution-environment
 * defaults the harness used to set up. Yields native SDK events.
 */
export function createClaudeSDKAgent(options: ClaudeSDKAgentOptions = {}): ClaudeSDKAgent {
  const resolvedModel = resolveModelId(options.model);
  return {
    async *query(prompt: string): AsyncGenerator<any, void> {
      // Lazy import keeps this side-effect-free at module load.
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const finalPrompt = options.wrapPrompt
        ? wrapPrompt(prompt, { workspacePath: options.workspacePath, workingDirectory: options.workingDirectory })
        : prompt;

      const sdkOptions: Record<string, any> = {
        systemPrompt: getSystemPrompt(options.cwd),
        model: resolvedModel,
        cwd: options.cwd || process.cwd(),
        permissionMode: options.permissionMode || 'bypassPermissions',
        allowDangerouslySkipPermissions: (options.permissionMode || 'bypassPermissions') === 'bypassPermissions',
        allowedTools: options.allowedTools ? [...options.allowedTools] : [...AGENT_TOOLS],
        includePartialMessages: false,
        settingSources: ['project'],
        persistSession: options.persistSession ?? false,
        maxThinkingTokens: options.maxThinkingTokens ?? 16000,
      };
      if (options.maxTurns) sdkOptions.maxTurns = options.maxTurns;
      if (options.hooks) sdkOptions.hooks = options.hooks;
      if (options.abortController) sdkOptions.abortController = options.abortController;
      if (options.env) sdkOptions.env = options.env;
      if (options.outputFormat) sdkOptions.outputFormat = options.outputFormat;

      const execPath = options.pathToClaudeCodeExecutable || findClaudeExecutable();
      if (execPath) sdkOptions.pathToClaudeCodeExecutable = execPath;

      const stream = query({ prompt: finalPrompt, options: sdkOptions });
      for await (const event of stream) {
        yield event;
      }
    },
  };
}
