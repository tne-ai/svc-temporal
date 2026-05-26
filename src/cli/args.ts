/**
 * Minimal --flag / --flag=value / --flag value argv parser.
 *
 * No dependency on yargs / minimist — keeps the CLI bundle tiny and the
 * behavior obvious. Supports:
 *   --foo bar         → { foo: 'bar' }
 *   --foo=bar         → { foo: 'bar' }
 *   --flag            → { flag: true }      (when next token starts with --)
 *   positional        → returned in .positional[]
 */
export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[body] = true;
        } else {
          flags[body] = next;
          i++;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

export function requireString(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== 'string' || !v) {
    console.error(`Missing required --${name}`);
    process.exit(2);
  }
  return v;
}

export function optionalString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  const v = flags[name];
  if (v === true) return true;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return false;
}

export function optionalNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
