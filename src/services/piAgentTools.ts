/**
 * Pi tool implementations — Read / Write / Edit / Bash / Glob / Grep /
 * WebSearch / WebFetch / TodoWrite.
 *
 * The Pi framework (@mariozechner/pi-agent-core) ships no built-in tools;
 * each integration BYO. This module ports the tools the non-Anthropic
 * reasoning path actually uses to Pi's `AgentTool` shape.
 *
 * Workspace scoping: file tools refuse paths outside cwd to mirror the
 * harness's permissionMode='bypassPermissions' default + the SDK's
 * additionalDirectories scoping.
 *
 * TodoWrite state lives in TodoState — one instance per session. Caller
 * builds the toolset with a session-scoped state to enable continuity
 * across queries within one chat.
 */

import { promises as fs } from 'fs';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import path from 'path';
import { glob } from 'glob';
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

/**
 * Minimal Tavily search — orion has a richer wrapper inside its
 * llmRouter; svc-temporal activities don't need all of that. When
 * TAVILY_API_KEY isn't set the tool returns a clear "not configured"
 * message rather than failing the run, since most temporal activities
 * don't actually invoke WebSearch.
 */
export function getGitHubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GH_TOKEN
    || env.GITHUB_TOKEN
    || env.GITHUB_PAT
    || env.GITHUB_PERSONAL_ACCESS_TOKEN
    || env.TNE_PLUGINS_GITHUB_TOKEN;
}

export function buildGitAskPassEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = getGitHubToken(baseEnv);
  if (!token) return {};
  const dir = mkdtempSync(path.join(tmpdir(), 'git-askpass-'));
  const script = path.join(dir, 'askpass.sh');
  writeFileSync(script, [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) printf "%s\n" "x-access-token" ;;',
    '  *) printf "%s\n" "$GITHUB_TOKEN" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(script, 0o700);
  return {
    GIT_ASKPASS: script,
    GIT_TERMINAL_PROMPT: '0',
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GITHUB_PERSONAL_ACCESS_TOKEN: token,
  };
}

async function executeTavilySearch(args: { query: string; max_results?: number }): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return 'WebSearch is not configured (TAVILY_API_KEY not set on the worker).';
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: args.query,
      max_results: args.max_results ?? 5,
      include_answer: true,
    }),
  });
  if (!res.ok) return `WebSearch failed: HTTP ${res.status} from Tavily`;
  const data: any = await res.json();
  const answer = data?.answer ? `Answer: ${data.answer}\n\n` : '';
  const results = Array.isArray(data?.results) ? data.results : [];
  const hits = results
    .map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content || '').slice(0, 240)}`)
    .join('\n\n');
  return `${answer}${hits}` || '(no results)';
}

/**
 * Workspace-scoped paths only — refuse anything outside cwd to mirror the
 * harness's permissionMode='bypassPermissions' default + the SDK's
 * additionalDirectories scoping. Caller passes the workspace root.
 */
function resolveInsideWorkspace(workspaceRoot: string, requested: string): string {
  const abs = path.isAbsolute(requested) ? requested : path.join(workspaceRoot, requested);
  const normalized = path.normalize(abs);
  if (!normalized.startsWith(path.normalize(workspaceRoot))) {
    throw new Error(`path "${requested}" escapes workspace root ${workspaceRoot}`);
  }
  return normalized;
}

/**
 * Sanity-check a Bash command for workspace escape attempts.
 *
 * Pi's Bash tool runs `bash -c <command>` with cwd=workspaceRoot but no
 * sandbox, so without this check the model can `cat ../.claude/foo` or
 * `find /` and exfiltrate / pollute paths the caller intended to be
 * scoped to cwd. The other Pi tools (Read/Write/Edit/Glob/Grep) enforce
 * scoping via resolveInsideWorkspace; Bash is the loophole.
 *
 * Heuristic — not a true sandbox, but catches the obvious misuse:
 *   1. Reject any `..` reference. Path traversal is the primary escape
 *      vector and there's no legitimate reason to need it inside cwd.
 *   2. Reject absolute paths that don't start with workspaceRoot OR a
 *      narrow allowlist of system tool dirs (/bin, /usr, /opt, /etc/...
 *      for read-only system files like /etc/hostname). Catches absolute
 *      escapes like `cat /var/folders/.../user-X/.claude/EBP/foo`.
 *
 * Doesn't try to handle: shell expansion that constructs paths
 * dynamically (`cat $HOME/...`), encoded paths (`echo Li4= | base64 -d`),
 * symlink trickery. Those are out of scope for a heuristic check; if
 * tightening is needed later, the right answer is OS-level isolation
 * (chroot / mount namespaces / containers).
 */
const ALLOWED_ABS_PREFIXES = [
  '/bin/', '/usr/', '/opt/', '/sbin/',
  '/etc/hostname', '/etc/os-release', '/etc/timezone',
  '/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr',
];

export function checkBashCommandSafety(
  command: string,
  workspaceRoot: string,
): { ok: true } | { ok: false; reason: string } {
  // 1. Block `..` traversal in any token boundary. We don't try to
  //    distinguish "harmless string `..`" from "path traversal" — the
  //    cost of being wrong (workspace exfiltration) outweighs the cost
  //    of the model rephrasing without `..`.
  if (/(?:^|[\s/'"`(=:])\.\.(?:[\s/'"`)$]|$)/.test(command)) {
    return { ok: false, reason: 'parent-dir traversal (..) blocked' };
  }
  // 2. Find absolute paths that escape the workspace. The regex matches
  //    the longest run of /-leading path-shaped tokens; reject any that
  //    don't start with the workspace root or an allowlisted system
  //    prefix. We normalize workspaceRoot once for prefix comparison.
  const wsAbs = path.normalize(workspaceRoot);
  // Match /...word.like... — looks for absolute paths in the command.
  // Excludes things like `2>/dev/null` (handled by allowlist) and
  // mid-token slashes like `a/b/c` (no leading boundary char).
  const absPathRe = /(?<![A-Za-z0-9_])(\/[A-Za-z0-9_./-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = absPathRe.exec(command)) !== null) {
    // URLs like https://github.com/org/repo.git are not filesystem paths.
    // The regex sees the //github.com segment as an absolute path unless we
    // explicitly ignore slash-runs immediately following a URI/config colon
    // (also covers git config keys such as url.https:/.insteadOf).
    if (m.index > 0 && command[m.index - 1] === ':') continue;
    const p = path.normalize(m[1]);
    if (p.startsWith(wsAbs)) continue;
    if (ALLOWED_ABS_PREFIXES.some((prefix) =>
      p === prefix.replace(/\/$/, '') || p.startsWith(prefix),
    )) continue;
    return { ok: false, reason: `absolute path "${m[1]}" escapes workspace ${wsAbs}` };
  }
  return { ok: true };
}

const ReadParams = Type.Object({
  file_path: Type.String({ description: 'File path, absolute or relative to workspace root' }),
  offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-based)' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum lines to return' })),
});

const WriteParams = Type.Object({
  file_path: Type.String(),
  content: Type.String(),
});

const EditParams = Type.Object({
  file_path: Type.String(),
  old_string: Type.String({ description: 'Exact string to replace (must be unique in file)' }),
  new_string: Type.String(),
  replace_all: Type.Optional(Type.Boolean()),
});

const BashParams = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in ms (default 120000)' })),
  description: Type.Optional(Type.String()),
});

/**
 * Per-session TodoWrite state. The Claude SDK / harness model is that the
 * agent maintains an evolving todo list during the run; the tool just
 * records the latest version. We keep an in-process map keyed by session
 * so concurrent sessions don't clobber each other.
 */
export interface PiTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

const todoStates = new Map<string, PiTodoItem[]>();

export function getTodoState(sessionKey: string): PiTodoItem[] {
  return todoStates.get(sessionKey) || [];
}

export function clearTodoState(sessionKey: string): void {
  todoStates.delete(sessionKey);
}

const GlobParams = Type.Object({
  pattern: Type.String({ description: 'Glob pattern (e.g. "**/*.ts")' }),
  path: Type.Optional(Type.String({ description: 'Directory to search in. Defaults to workspace root.' })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: 'Regular expression to search for' }),
  path: Type.Optional(Type.String({ description: 'File or directory to search. Defaults to workspace root.' })),
  glob: Type.Optional(Type.String({ description: 'Filter files by glob (e.g. "*.ts")' })),
  output_mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('files_with_matches'), Type.Literal('count')], { description: 'Default content' })),
  '-i': Type.Optional(Type.Boolean({ description: 'Case-insensitive' })),
  '-n': Type.Optional(Type.Boolean({ description: 'Show line numbers (only with content output)' })),
  head_limit: Type.Optional(Type.Number({ description: 'Cap on lines/files returned' })),
});

const WebSearchParams = Type.Object({
  query: Type.String(),
  max_results: Type.Optional(Type.Number({ description: 'Default 5' })),
});

const WebFetchParams = Type.Object({
  url: Type.String(),
  prompt: Type.Optional(Type.String({ description: 'Ignored — included for SDK compatibility' })),
});

const TodoWriteParams = Type.Object({
  todos: Type.Array(Type.Object({
    content: Type.String(),
    status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
    activeForm: Type.Optional(Type.String()),
  })),
});

export interface BuildPiToolsOptions {
  /** Stable identifier for the session — TodoWrite stores its list keyed by this. */
  sessionKey?: string;
  /** Per-job env overrides, e.g. user-scoped GH_TOKEN/GITHUB_TOKEN. */
  env?: NodeJS.ProcessEnv;
}

export function buildPiTools(workspaceRoot: string, opts: BuildPiToolsOptions = {}): AgentTool<any>[] {
  const sessionKey = opts.sessionKey || workspaceRoot;
  const Read: AgentTool<typeof ReadParams> = {
    name: 'Read',
    label: 'Read file',
    description: 'Read the contents of a file. Returns up to `limit` lines starting at `offset` (1-based).',
    parameters: ReadParams,
    execute: async (_toolCallId, params: Static<typeof ReadParams>, _signal) => {
      const filePath = resolveInsideWorkspace(workspaceRoot, params.file_path);
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.split('\n');
      const start = (params.offset ?? 1) - 1;
      const end = params.limit ? start + params.limit : lines.length;
      const slice = lines.slice(Math.max(0, start), Math.max(0, end));
      const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n');
      return {
        content: [{ type: 'text', text: numbered }],
        details: { path: filePath, lines: slice.length },
      };
    },
  };

  const Write: AgentTool<typeof WriteParams> = {
    name: 'Write',
    label: 'Write file',
    description: 'Create or overwrite a file with the given content.',
    parameters: WriteParams,
    execute: async (_toolCallId, params: Static<typeof WriteParams>) => {
      const filePath = resolveInsideWorkspace(workspaceRoot, params.file_path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, 'utf-8');
      return {
        content: [{ type: 'text', text: `wrote ${params.content.length} chars to ${filePath}` }],
        details: { path: filePath, bytes: Buffer.byteLength(params.content, 'utf-8') },
      };
    },
  };

  const Edit: AgentTool<typeof EditParams> = {
    name: 'Edit',
    label: 'Edit file',
    description: 'Replace `old_string` with `new_string` in a file. Fails if old_string is not unique unless replace_all is true.',
    parameters: EditParams,
    execute: async (_toolCallId, params: Static<typeof EditParams>) => {
      const filePath = resolveInsideWorkspace(workspaceRoot, params.file_path);
      const original = await fs.readFile(filePath, 'utf-8');
      const occurrences = original.split(params.old_string).length - 1;
      if (occurrences === 0) {
        throw new Error(`old_string not found in ${filePath}`);
      }
      if (occurrences > 1 && !params.replace_all) {
        throw new Error(`old_string occurs ${occurrences} times in ${filePath}; pass replace_all=true to replace every occurrence`);
      }
      const updated = params.replace_all
        ? original.split(params.old_string).join(params.new_string)
        : original.replace(params.old_string, params.new_string);
      await fs.writeFile(filePath, updated, 'utf-8');
      return {
        content: [{ type: 'text', text: `replaced ${occurrences} occurrence(s) in ${filePath}` }],
        details: { path: filePath, occurrences },
      };
    },
  };

  const Bash: AgentTool<typeof BashParams> = {
    name: 'Bash',
    label: 'Run shell command',
    description:
      'Run a shell command in the workspace root. Output is captured and returned. ' +
      'Default timeout 120s. Path traversal (..) and absolute paths outside the ' +
      'workspace are rejected — use relative paths inside the working directory.',
    parameters: BashParams,
    execute: async (_toolCallId, params: Static<typeof BashParams>, signal) => {
      const timeoutMs = params.timeout ?? 120_000;
      // Sandbox check: refuse commands that try to escape the workspace.
      // The same scoping enforcement Read/Write/Edit/Glob/Grep apply,
      // applied to Bash by static-analyzing the command string.
      const safety = checkBashCommandSafety(params.command, workspaceRoot);
      if (!safety.ok) {
        return {
          content: [{ type: 'text', text: `Bash command rejected: ${safety.reason}` }],
          details: { exitCode: 1, command: params.command, rejected: true, reason: safety.reason },
        };
      }
      return await new Promise((resolve, reject) => {
        const child = spawn('/bin/bash', ['-c', params.command], {
          cwd: workspaceRoot,
          env: { ...process.env, ...(opts.env || {}), ...buildGitAskPassEnv({ ...process.env, ...(opts.env || {}) }) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const onAbort = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', onAbort);

        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.stdout?.on('data', (b) => { stdout += b.toString(); });
        child.stderr?.on('data', (b) => { stderr += b.toString(); });
        child.on('error', (err) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
          resolve({
            content: [{ type: 'text', text: combined.slice(0, 50_000) }],
            details: { exitCode: code, command: params.command },
          });
        });
      });
    },
  };

  const Glob: AgentTool<typeof GlobParams> = {
    name: 'Glob',
    label: 'Glob files',
    description: 'List files matching a glob pattern. Supports ** for recursive match.',
    parameters: GlobParams,
    execute: async (_toolCallId, params: Static<typeof GlobParams>) => {
      const cwd = params.path
        ? resolveInsideWorkspace(workspaceRoot, params.path)
        : workspaceRoot;
      const matches = await glob(params.pattern, {
        cwd,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      });
      // Sort by mtime desc to match Claude SDK's Glob behavior; fall back
      // to lexicographic on stat errors.
      const withStat = await Promise.all(
        matches.map(async (m) => {
          try { return { path: m, mtime: (await fs.stat(m)).mtimeMs }; }
          catch { return { path: m, mtime: 0 }; }
        }),
      );
      withStat.sort((a, b) => b.mtime - a.mtime);
      const list = withStat.map((m) => m.path);
      return {
        content: [{ type: 'text', text: list.length === 0 ? '(no matches)' : list.join('\n') }],
        details: { matchCount: list.length, cwd, pattern: params.pattern },
      };
    },
  };

  const Grep: AgentTool<typeof GrepParams> = {
    name: 'Grep',
    label: 'Grep',
    description: 'Search file contents for a regex. Uses ripgrep when available, falls back to system grep.',
    parameters: GrepParams,
    execute: async (_toolCallId, params: Static<typeof GrepParams>, signal) => {
      const target = params.path
        ? resolveInsideWorkspace(workspaceRoot, params.path)
        : workspaceRoot;
      const mode = params.output_mode ?? 'content';
      // Prefer ripgrep — it's faster, respects .gitignore, and emits
      // line numbers cleanly. Fall back to grep -r if rg isn't on PATH.
      const args: string[] = [];
      if (params['-i']) args.push('-i');
      if (mode === 'content' && params['-n']) args.push('-n');
      if (params.glob) args.push('-g', params.glob);
      if (mode === 'files_with_matches') args.push('-l');
      if (mode === 'count') args.push('-c');
      args.push('--', params.pattern, target);

      const tryRun = (cmd: string, cmdArgs: string[]) => new Promise<{ ok: boolean; stdout: string; code: number | null }>((resolve) => {
        const child = spawn(cmd, cmdArgs, { cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        const onAbort = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', onAbort);
        child.stdout?.on('data', (b) => { stdout += b.toString(); });
        child.on('error', () => resolve({ ok: false, stdout: '', code: null }));
        child.on('close', (code) => {
          signal?.removeEventListener('abort', onAbort);
          // grep/rg exit 1 when no matches — that's not an error for us.
          resolve({ ok: code === 0 || code === 1, stdout, code });
        });
      });

      let out = await tryRun('rg', args);
      if (!out.ok && out.code === null) out = await tryRun('grep', ['-r', ...args]);
      let text = out.stdout;
      if (params.head_limit && text) {
        text = text.split('\n').slice(0, params.head_limit).join('\n');
      }
      const matchCount = text ? text.split('\n').filter(Boolean).length : 0;
      return {
        content: [{ type: 'text', text: text || '(no matches)' }],
        details: { matchCount, mode, pattern: params.pattern },
      };
    },
  };

  const WebSearch: AgentTool<typeof WebSearchParams> = {
    name: 'WebSearch',
    label: 'Web search',
    description: 'Search the web via Tavily. Returns titles, URLs, and content snippets.',
    parameters: WebSearchParams,
    execute: async (_toolCallId, params: Static<typeof WebSearchParams>) => {
      const out = await executeTavilySearch({
        query: params.query,
        max_results: params.max_results ?? 5,
      });
      return {
        content: [{ type: 'text', text: out }],
        details: { query: params.query },
      };
    },
  };

  const WebFetch: AgentTool<typeof WebFetchParams> = {
    name: 'WebFetch',
    label: 'Web fetch',
    description: 'Fetch a URL and return its text content (HTML stripped to readable text).',
    parameters: WebFetchParams,
    execute: async (_toolCallId, params: Static<typeof WebFetchParams>, signal) => {
      const response = await fetch(params.url, {
        signal,
        headers: { 'User-Agent': 'orion-piagent/1.0' },
      });
      if (!response.ok) {
        return {
          content: [{ type: 'text', text: `HTTP ${response.status} fetching ${params.url}` }],
          details: { url: params.url, status: response.status },
        };
      }
      const contentType = response.headers.get('content-type') || '';
      const raw = await response.text();
      // Cheap HTML→text: strip tags and collapse whitespace. Good enough
      // for letting the model extract content; not a full readability
      // pipeline. Cap at 50k chars to keep context reasonable.
      const text = contentType.includes('html')
        ? raw.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<[^>]+>/g, ' ')
             .replace(/\s+/g, ' ')
             .trim()
        : raw;
      return {
        content: [{ type: 'text', text: text.slice(0, 50_000) }],
        details: { url: params.url, status: response.status, contentType, bytes: text.length },
      };
    },
  };

  const TodoWrite: AgentTool<typeof TodoWriteParams> = {
    name: 'TodoWrite',
    label: 'Update todos',
    description: 'Replace the current todo list with a new version. Each todo has content + status (pending/in_progress/completed).',
    parameters: TodoWriteParams,
    execute: async (_toolCallId, params: Static<typeof TodoWriteParams>) => {
      todoStates.set(sessionKey, params.todos);
      const summary = params.todos.length === 0
        ? '(empty)'
        : params.todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join('\n');
      return {
        content: [{ type: 'text', text: `Todos updated:\n${summary}` }],
        details: { count: params.todos.length, sessionKey },
      };
    },
  };

  // graph_traverse — available to ERP fleet skills (afl-*, rga-*, etc.)
  // Calls the in-process Kuzu graph server. Returns [] gracefully when the
  // graph server is not running (DISABLE_GRAPH_SERVER=1) or has no data yet.
  // Non-ERP skills can call this tool safely — it just returns an empty result.
  const GraphTraverseParams = Type.Object({
    fleet:           Type.String({ description: 'Fleet slug, e.g. "appfolio" or "regen-ag"' }),
    org_id:          Type.String({ description: 'Organisation ID' }),
    traversal_slug:  Type.String({ description: 'Named traversal from graph.yaml, e.g. "tenant_compliance_context"' }),
    params:          Type.Record(Type.String(), Type.String(), { description: 'Parameter bindings for the Cypher query' }),
  });

  const GraphTraverse: AgentTool<typeof GraphTraverseParams> = {
    name: 'graph_traverse',
    label: 'Graph traversal',
    description:
      'Run a named knowledge graph traversal for an ERP fleet entity. ' +
      'Returns cross-entity context (e.g. tenant → unit → property → certs → subsidy) ' +
      'without writing SQL joins. Use before validating or reasoning about compliance state.',
    parameters: GraphTraverseParams,
    execute: async (_toolCallId, p: Static<typeof GraphTraverseParams>) => {
      const port = parseInt(process.env.GRAPH_SERVER_PORT ?? '8001', 10);
      const secret = process.env.GRAPH_SERVER_SECRET ?? '';
      try {
        const body = JSON.stringify({
          fleet: p.fleet, org_id: p.org_id,
          traversal_slug: p.traversal_slug, params: p.params,
        });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (secret) {
          const { createHmac } = await import('crypto');
          headers['x-graph-signature'] = createHmac('sha256', secret).update(body).digest('hex');
        }
        const res = await fetch(`http://127.0.0.1:${port}/graph/traverse`, {
          method: 'POST', headers, body,
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: 'text', text: `graph_traverse error: ${err}` }], details: { count: 0 } };
        }
        const data = await res.json() as { rows: unknown[] };
        const text = JSON.stringify(data.rows, null, 2);
        return { content: [{ type: 'text', text }], details: { count: data.rows.length } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `graph_traverse unavailable: ${msg}` }], details: { count: 0 } };
      }
    },
  };

  return [Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, TodoWrite, GraphTraverse];
}
