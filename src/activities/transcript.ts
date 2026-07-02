/**
 * Per-step agent transcript capture (cvc-scoped; gated by env TRANSCRIPT_CAPTURE).
 *
 * Taps the SDK message stream the engine already consumes and persists it
 * durably, so "who wrote each file / spent which tokens" is answerable per step
 * after the run. Best-effort — never throws into the run loop; a capture failure
 * cannot affect execution. Capturing adds zero model tokens (it copies a stream
 * the model already produced).
 *
 * Per step: a raw JSONL of every SDK event (complete, machine-parseable).
 * Per run:  a human-readable manifest.md index (tokens, cost, files written,
 *           links to each step's .jsonl).
 *
 * Storage: <workspaceRoot>/transcripts/<runId>/ — plain local disk; rides the
 * existing workspace->S3 sync in prod. Keyed by the universal FSM runId.
 */
import { promises as fs } from 'fs';
import { join } from 'path';

const MAX_EVENT_CHARS = 20000; // cap a single serialized event in the JSONL
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface RecorderMeta {
  runId?: string;
  phase?: string;
  stepNumber?: string;
  skill?: string;
  workspaceRoot?: string;
  model?: string;
}

function redact(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-ant-[a-zA-Z0-9_-]{8,}/g, 'sk-ant-***REDACTED***')
    .replace(/sk-[a-zA-Z0-9]{16,}/g, 'sk-***REDACTED***')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_***REDACTED***')
    .replace(/(["']?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?)([^\s"',}]{4,})/gi, '$1***REDACTED***');
}

function fileFrom(name: string, input: any): string | null {
  if (!FILE_TOOLS.has(name) || !input) return null;
  const f = input.file_path || input.path || input.notebook_path;
  return f ? String(f) : null;
}

class Recorder {
  private meta: RecorderMeta;
  private dir: string;
  private jsonlName: string;
  private lines: string[] = [];
  private filesWritten = new Set<string>();
  private toolUses = 0;
  private tokensIn = 0;
  private cacheRead = 0;
  private cacheCreate = 0;
  private tokensOut = 0;
  private costUsd = 0;
  private started = Date.now();

  constructor(meta: RecorderMeta) {
    this.meta = meta;
    this.dir = join(String(meta.workspaceRoot), 'transcripts', String(meta.runId));
    const key = `${meta.phase || 'phase'}.${meta.stepNumber || '0'}__${meta.skill || 'skill'}`;
    this.jsonlName = `${key}.jsonl`;
  }

  record(ev: any): void {
    try {
      const t = ev?.type;
      if (t === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b?.type === 'tool_use') {
            this.toolUses++;
            const f = fileFrom(b.name, b.input);
            if (f) this.filesWritten.add(f);
          }
        }
      } else if (t === 'result') {
        const u = ev.usage || {};
        this.tokensIn += Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0) || 0;
        this.cacheRead += Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0) || 0;
        this.cacheCreate += Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0) || 0;
        this.tokensOut += Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0) || 0;
        this.costUsd += Number(ev.total_cost_usd ?? 0) || 0;
      }
      let line = redact(JSON.stringify({ ts: Date.now(), ev }));
      if (line.length > MAX_EVENT_CHARS) line = line.slice(0, MAX_EVENT_CHARS) + '"__TRUNCATED__"';
      this.lines.push(line);
    } catch {
      /* best-effort */
    }
  }

  async finalize(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(join(this.dir, this.jsonlName), this.lines.join('\n') + '\n');
      const key = `${this.meta.phase || 'phase'}.${this.meta.stepNumber || '0'}`;
      const skill = this.meta.skill || 'skill';
      const files = Array.from(this.filesWritten);
      const secs = ((Date.now() - this.started) / 1000).toFixed(1);
      const manifest = join(this.dir, 'manifest.md');
      let head = '';
      try {
        await fs.access(manifest);
      } catch {
        head =
          `# Transcript manifest — run \`${this.meta.runId}\`\n\n` +
          `| Step | Skill | Tokens in/out | Cache rd/wr | Cost USD | Tools | Wall | Files written | Transcript |\n` +
          `|------|-------|---------------|-------------|----------|-------|------|---------------|------------|\n`;
      }
      const filesCell = files.length ? files.map((f) => `\`${f}\``).join('<br>') : '—';
      const totalIn = this.tokensIn + this.cacheRead + this.cacheCreate;
      const row =
        `| ${key} | ${skill} | ${totalIn}/${this.tokensOut} | ` +
        `${this.cacheRead}/${this.cacheCreate} | ` +
        `${this.costUsd ? this.costUsd.toFixed(4) : '—'} | ${this.toolUses} | ${secs}s | ${filesCell} | ` +
        `[${this.jsonlName}](./${this.jsonlName}) |\n`;
      await fs.appendFile(manifest, head + row);
    } catch {
      /* best-effort */
    }
  }
}

export async function* teeRecord(src: AsyncIterable<any>, meta: RecorderMeta): AsyncIterable<any> {
  const on = !!process.env.TRANSCRIPT_CAPTURE && !!meta.runId && !!meta.workspaceRoot;
  const rec = on ? new Recorder(meta) : null;
  try {
    for await (const ev of src) {
      if (rec) rec.record(ev);
      yield ev;
    }
  } finally {
    if (rec) await rec.finalize();
  }
}
