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
import { GRAPH_SERVICE_URL, GRAPH_SECRET, ERP_BASE_URL, ERP_API_KEY } from '../shared/constants.js';

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

  // graph_traverse — calls graph-svc at GRAPH_SERVICE_URL.
  // Resolves the named traversal slug to Cypher from config/{fleet}/graph.yaml,
  // then sends it to graph-svc POST /graph/{fleet}/{org_id}/query.
  // Returns [] gracefully if graph-svc is unreachable or the slug is unknown.
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
      const graphUrl = GRAPH_SERVICE_URL;
      const secret = GRAPH_SECRET;
      try {
        // Resolve traversal slug → Cypher from config/{fleet}/graph.yaml
        const configDir = process.env.CONFIG_DIR ?? path.join(process.cwd(), 'config');
        const yamlPath = path.join(configDir, p.fleet, 'graph.yaml');
        const { readFileSync } = await import('fs');
        const { load } = await import('js-yaml');
        let cypher: string;
        try {
          const raw = readFileSync(yamlPath, 'utf8');
          const parsed = load(raw) as { graph: { traversals: Record<string, { pattern: string }> } };
          const traversal = parsed?.graph?.traversals?.[p.traversal_slug];
          if (!traversal) {
            return { content: [{ type: 'text', text: `graph_traverse: unknown traversal '${p.traversal_slug}' for fleet '${p.fleet}'` }], details: { count: 0 } };
          }
          cypher = traversal.pattern;
        } catch {
          return { content: [{ type: 'text', text: `graph_traverse: no graph.yaml for fleet '${p.fleet}'` }], details: { count: 0 } };
        }

        const body = JSON.stringify({ cypher, params: p.params });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (secret) headers['x-graph-secret'] = secret;

        const res = await fetch(`${graphUrl}/graph/${p.fleet}/${p.org_id}/query`, {
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

  // graph_query — raw Cypher, no config anywhere. The agent supplies the
  // query directly (same as app-erp's own POST /api/graph/query, which
  // agent-manual.md already documents as the primary way LOCAL skills read
  // the graph today — graph_traverse's named-slug indirection is the
  // exception, not the norm). Mirrors activities/graphQuery.ts's shape
  // (fleet/orgId/cypher/params) but exposed as an LLM-callable tool rather
  // than workflow-only. Calls graph-svc directly — same GRAPH_SERVICE_URL/
  // GRAPH_SECRET trust boundary graph_traverse and graphQuery.ts already
  // have in this deployed environment.
  const GraphQueryParams = Type.Object({
    fleet:   Type.String({ description: 'Fleet slug, e.g. "appfolio" or "regen-ag"' }),
    org_id:  Type.String({ description: 'Organisation ID' }),
    cypher:  Type.String({ description: 'Cypher query to run against the graph' }),
    params:  Type.Record(Type.String(), Type.String(), { description: 'Parameter bindings for the Cypher query' }),
  });

  const GraphQuery: AgentTool<typeof GraphQueryParams> = {
    name: 'graph_query',
    label: 'Graph query',
    description:
      'Run a raw Cypher query against the knowledge graph for an ERP fleet/org. ' +
      'Use this for anything graph_traverse\'s small set of pre-named traversals ' +
      'doesn\'t cover — write the Cypher yourself against the fleet\'s node/edge types.',
    parameters: GraphQueryParams,
    execute: async (_toolCallId, p: Static<typeof GraphQueryParams>) => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (GRAPH_SECRET) headers['x-graph-secret'] = GRAPH_SECRET;

        const res = await fetch(`${GRAPH_SERVICE_URL}/graph/${p.fleet}/${p.org_id}/query`, {
          method: 'POST', headers,
          body: JSON.stringify({ cypher: p.cypher, params: p.params }),
        });
        if (!res.ok) {
          const err = await res.text();
          return { content: [{ type: 'text', text: `graph_query error: ${err}` }], details: { count: 0 } };
        }
        const data = await res.json() as { rows: unknown[] };
        const text = JSON.stringify(data.rows, null, 2);
        return { content: [{ type: 'text', text }], details: { count: data.rows.length } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `graph_query unavailable: ${msg}` }], details: { count: 0 } };
      }
    },
  };

  // ── app-erp tools ──────────────────────────────────────────────────────
  // Mirror app-erp's own already-documented HTTP contract (docs/agent-manual.md
  // in the app-erp repo) instead of inventing bespoke per-action names —
  // one generic entity CRUD pattern covers nearly every SKILL.md today.
  // Every write requires `source` (app-erp rejects writes without it — no
  // way to bypass provenance tracking through this route either).

  const erpHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ERP_API_KEY) h['Authorization'] = `Bearer ${ERP_API_KEY}`;
    return h;
  };

  const erpResult = async (res: Response) => {
    const text = await res.text();
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `app-erp error (${res.status}): ${text}` }], details: { ok: false, status: res.status } };
    }
    return { content: [{ type: 'text' as const, text }], details: { ok: true, status: res.status } };
  };

  const ErpGetEntitiesParams = Type.Object({
    entity:    Type.String({ description: 'Singular entity name matching the schema exactly, e.g. "member" not "members" — check erp_get_schema if unsure' }),
    filters:   Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Equality filters, e.g. {"current_status": "active"}' })),
    limit:     Type.Optional(Type.Number()),
    offset:    Type.Optional(Type.Number()),
    order_by:  Type.Optional(Type.String()),
    order_dir: Type.Optional(Type.String()),
  });
  const ErpGetEntities: AgentTool<typeof ErpGetEntitiesParams> = {
    name: 'erp_get_entities',
    label: 'List app-erp entities',
    description: 'List/filter rows of an app-erp entity (member, product, field, harvest_batch, etc.). Read-only.',
    parameters: ErpGetEntitiesParams,
    execute: async (_toolCallId, p: Static<typeof ErpGetEntitiesParams>) => {
      const params = new URLSearchParams();
      if (p.limit != null) params.set('limit', String(p.limit));
      if (p.offset != null) params.set('offset', String(p.offset));
      if (p.order_by) params.set('order_by', p.order_by);
      if (p.order_dir) params.set('order_dir', p.order_dir);
      if (p.filters) params.set('filters', JSON.stringify(p.filters));
      const res = await fetch(`${ERP_BASE_URL}/api/entities/${p.entity}?${params}`, { headers: erpHeaders() });
      return erpResult(res);
    },
  };

  const ErpGetEntityParams = Type.Object({
    entity: Type.String({ description: 'Singular entity name, e.g. "member"' }),
    id:     Type.String({ description: 'Primary key value' }),
  });
  const ErpGetEntity: AgentTool<typeof ErpGetEntityParams> = {
    name: 'erp_get_entity',
    label: 'Get app-erp entity',
    description: 'Fetch a single app-erp entity row by id. Read-only.',
    parameters: ErpGetEntityParams,
    execute: async (_toolCallId, p: Static<typeof ErpGetEntityParams>) => {
      const res = await fetch(`${ERP_BASE_URL}/api/entities/${p.entity}/${p.id}`, { headers: erpHeaders() });
      return erpResult(res);
    },
  };

  const ErpCreateEntityParams = Type.Object({
    entity:     Type.String({ description: 'Singular entity name, e.g. "member"' }),
    fields:     Type.Record(Type.String(), Type.Unknown(), { description: 'Column values — only columns declared in the entity schema; PK and source_* are server-set' }),
    source:     Type.String({ description: 'Required — free-text identifier of who/what made this write (your own skill name, or "user")' }),
    source_ref: Type.Optional(Type.String({ description: 'Optional pointer back to the specific origin (external id, source slug)' })),
  });
  const ErpCreateEntity: AgentTool<typeof ErpCreateEntityParams> = {
    name: 'erp_create_entity',
    label: 'Create app-erp entity',
    description: 'Create a new app-erp entity row. WRITE — has a real side effect.',
    parameters: ErpCreateEntityParams,
    execute: async (_toolCallId, p: Static<typeof ErpCreateEntityParams>) => {
      const res = await fetch(`${ERP_BASE_URL}/api/entities/${p.entity}`, {
        method: 'POST', headers: erpHeaders(),
        body: JSON.stringify({ source: p.source, source_ref: p.source_ref, fields: p.fields }),
      });
      return erpResult(res);
    },
  };

  const ErpUpdateEntityParams = Type.Object({
    entity:     Type.String({ description: 'Singular entity name, e.g. "member"' }),
    id:         Type.String({ description: 'Primary key value of the row to update' }),
    fields:     Type.Record(Type.String(), Type.Unknown(), { description: 'Column values to change — only columns declared in the entity schema' }),
    source:     Type.String({ description: 'Required — free-text identifier of who/what made this write' }),
    source_ref: Type.Optional(Type.String()),
  });
  const ErpUpdateEntity: AgentTool<typeof ErpUpdateEntityParams> = {
    name: 'erp_update_entity',
    label: 'Update app-erp entity',
    description: 'Update an existing app-erp entity row. WRITE — has a real side effect.',
    parameters: ErpUpdateEntityParams,
    execute: async (_toolCallId, p: Static<typeof ErpUpdateEntityParams>) => {
      const res = await fetch(`${ERP_BASE_URL}/api/entities/${p.entity}/${p.id}`, {
        method: 'PUT', headers: erpHeaders(),
        body: JSON.stringify({ source: p.source, source_ref: p.source_ref, fields: p.fields }),
      });
      return erpResult(res);
    },
  };

  const ErpGetSchemaParams = Type.Object({
    table: Type.Optional(Type.String({ description: 'Specific table name, or omit for the full schema' })),
  });
  const ErpGetSchema: AgentTool<typeof ErpGetSchemaParams> = {
    name: 'erp_get_schema',
    label: 'app-erp schema',
    description: 'Discover the live app-erp database schema — every table/column/type, or one table\'s detail. Check before assuming a column does or doesn\'t exist; this is always current, unlike prose docs.',
    parameters: ErpGetSchemaParams,
    execute: async (_toolCallId, p: Static<typeof ErpGetSchemaParams>) => {
      const path = p.table ? `/api/db/schema/${p.table}` : '/api/db/schema';
      const res = await fetch(`${ERP_BASE_URL}${path}`, { headers: erpHeaders() });
      return erpResult(res);
    },
  };

  const ErpGetRulesParams = Type.Object({
    entity: Type.String({ description: 'Which domain\'s business rules to fetch, e.g. "compliance" — matches a SKILL.md\'s own domain, not necessarily a table name' }),
  });
  const ErpGetRules: AgentTool<typeof ErpGetRulesParams> = {
    name: 'erp_get_rules',
    label: 'app-erp business rules',
    description: 'Fetch this org\'s real business rules for a domain (compliance thresholds, formats, tolerances) — merges the industry baseline with any org-specific overrides. Check this instead of relying on hardcoded numbers in your own skill prompt; org overrides only take effect if you fetch fresh each time.',
    parameters: ErpGetRulesParams,
    execute: async (_toolCallId, p: Static<typeof ErpGetRulesParams>) => {
      const res = await fetch(`${ERP_BASE_URL}/api/config/rules?entity=${encodeURIComponent(p.entity)}`, { headers: erpHeaders() });
      return erpResult(res);
    },
  };

  const ErpInvokeAgentParams = Type.Object({
    skill:  Type.String({ description: 'Target entity agent\'s skill name, e.g. "rga-member"' }),
    prompt: Type.String({ description: 'Free-text instruction — the receiving agent decides which of its own intents this maps to' }),
  });
  const ErpInvokeAgent: AgentTool<typeof ErpInvokeAgentParams> = {
    name: 'erp_invoke_agent',
    label: 'Delegate to app-erp entity agent',
    description: 'Delegate a request to another app-erp entity agent (cross-domain work) instead of writing to its tables directly — each entity type is owned by one agent.',
    parameters: ErpInvokeAgentParams,
    execute: async (_toolCallId, p: Static<typeof ErpInvokeAgentParams>) => {
      // POST /api/agent returns an SSE stream — collect it into one result
      // rather than exposing streaming semantics through this tool.
      const res = await fetch(`${ERP_BASE_URL}/api/agent`, {
        method: 'POST', headers: erpHeaders(),
        body: JSON.stringify({ skill: p.skill, prompt: p.prompt }),
      });
      return erpResult(res);
    },
  };

  const ErpFetchUrlParams = Type.Object({
    url:         Type.String({ description: 'The external URL to fetch' }),
    source_slug: Type.String({ description: 'A name for this source, for the pull-log/sources registry' }),
  });
  const ErpFetchUrl: AgentTool<typeof ErpFetchUrlParams> = {
    name: 'erp_fetch_url',
    label: 'Fetch external URL (mediated)',
    description: 'Fetch a URL outside app-erp\'s known hosts (a link a user gave you, found in an email/document) through app-erp\'s mediated fetch — blocks internal/private/link-local addresses, enforces a size cap, logs the pull. Use this instead of fetching external URLs directly.',
    parameters: ErpFetchUrlParams,
    execute: async (_toolCallId, p: Static<typeof ErpFetchUrlParams>) => {
      const res = await fetch(`${ERP_BASE_URL}/api/intake/fetch-url`, {
        method: 'POST', headers: erpHeaders(),
        body: JSON.stringify({ url: p.url, source_slug: p.source_slug, auth_header: null }),
      });
      return erpResult(res);
    },
  };

  const ErpCallConnectorParams = Type.Object({
    slug:      Type.String({ description: 'Connector slug (e.g. "square-payments", or a generic agent-registered connector) — check GET /api/connectors for what exists' }),
    operation: Type.String({ description: 'One of the connector\'s declared read operations, e.g. "list_customers" — check the connector\'s spec if unsure' }),
    params:    Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Path/query params the operation needs, e.g. {"username": "octocat"} for a path template like /users/{username}/repos' })),
    limit:     Type.Optional(Type.Number({ description: 'Cap on records returned (default 25) — keep this small; you decide what to do with each record, so pulling hundreds at once just floods your own context' })),
  });
  const ErpCallConnector: AgentTool<typeof ErpCallConnectorParams> = {
    name: 'erp_call_connector',
    label: 'Pull raw connector data (mediated, read-only)',
    description:
      'Fetch RAW records from an external connector (Square, GitHub, or any agent-registered one) — no automatic mapping, no automatic write. Unlike POST /{name}/sync (which writes through a fixed field-mapping interpreter), this hands YOU the raw records so you can reason about each one and decide what to do: erp_invoke_agent to delegate to the entity agent that actually owns the target data (preferred — respects that agent\'s own business logic), erp_create_entity/erp_update_entity for a direct write you\'re confident about, or just report back what you found. Credentials are resolved entirely server-side — you never see them.',
    parameters: ErpCallConnectorParams,
    execute: async (_toolCallId, p: Static<typeof ErpCallConnectorParams>) => {
      const res = await fetch(`${ERP_BASE_URL}/api/connectors/${p.slug}/call`, {
        method: 'POST', headers: erpHeaders(),
        body: JSON.stringify({ operation: p.operation, params: p.params ?? {}, limit: p.limit ?? 25 }),
      });
      return erpResult(res);
    },
  };

  return [
    Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, TodoWrite, GraphTraverse, GraphQuery,
    ErpGetEntities, ErpGetEntity, ErpCreateEntity, ErpUpdateEntity, ErpGetSchema, ErpGetRules, ErpInvokeAgent, ErpFetchUrl,
    ErpCallConnector,
  ];
}
