/**
 * Provenance audit store for Tier 2 replay in backwardDispatch.
 *
 * Port of the Python engine's `provenance_store.py` (tne-plugins) for
 * svc-temporal parity. Records every CONVERGED backward execution as a
 * (output_hash -> input) mapping. Consumed by backwardDispatch's Tier 2
 * (provenance replay) for exact replay on repeat backward calls.
 *
 * Storage layout (mirrors the Python module, r-cai-bidi91 Principle IV):
 *     $TNE_DATA/ktap/provenance/{skill_slug}/{output_hash[:16]}.json
 *     ~/.tne/provenance/{skill_slug}/{output_hash[:16]}.json   (TNE_DATA unset)
 *
 * Each record:
 *   {
 *     "schema": "1",
 *     "skill": "<skill_slug>",
 *     "output_hash": "<sha256-hex>",
 *     "input": "<reconstructed-input-text>",
 *     "fidelity": 0.95,
 *     "tier": "tier0-llm",
 *     "recorded_at": "<ISO-8601-UTC>",
 *     "repair_id": "<repair-id-or-null>"
 *   }
 *
 * The pure functions (hashing, record building, root selection, key) are
 * exported for unit tests; the file-I/O wrappers (`recordProvenance`,
 * `lookupProvenance`) are Temporal activities (registered in index.ts).
 */
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export interface ProvenanceRecord {
  schema: '1';
  skill: string;
  output_hash: string;
  input: string;
  fidelity: number;
  tier: string;
  recorded_at: string;
  repair_id: string | null;
}

// ─── Pure logic (unit-tested) ────────────────────────────────────────────────

/** SHA-256 hex of an output artifact — the cache key (matches Python's hashlib). */
export function outputHash(outputArtifact: string): string {
  return createHash('sha256').update(outputArtifact, 'utf-8').digest('hex');
}

/** Short key used in the on-disk filename: first 16 hex chars of the hash. */
export function shortHash(outputArtifact: string): string {
  return outputHash(outputArtifact).slice(0, 16);
}

/**
 * Build the JSON record for a CONVERGED backward execution. Pure — does no
 * I/O. `nowIso` should be a UTC ISO-8601 timestamp ("YYYY-MM-DDTHH:MM:SSZ").
 * Fidelity is rounded to 4 places to match the Python writer.
 */
export function buildProvenanceRecord(params: {
  skill: string;
  outputArtifact: string;
  inputArtifact: string;
  fidelity: number;
  tier: string;
  nowIso: string;
  repairId?: string | null;
}): ProvenanceRecord {
  return {
    schema: '1',
    skill: params.skill,
    output_hash: outputHash(params.outputArtifact),
    input: params.inputArtifact,
    fidelity: Math.round(params.fidelity * 10000) / 10000,
    tier: params.tier,
    recorded_at: params.nowIso,
    repair_id: params.repairId ?? null,
  };
}

/**
 * Decide whether a parsed record is a usable cache HIT for a lookup.
 * Mirrors the Python `lookup()` guard: a record is a hit only when it
 * parsed and carries a non-empty `input`. Returns the input text, else null.
 *
 * Pure — callers feed it the already-read file content (or null on read
 * failure). Keeps the hit/miss decision testable without touching disk.
 */
export function selectRecordInput(raw: string | null): string | null {
  if (raw == null) return null;
  let record: Partial<ProvenanceRecord>;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  const input = record?.input;
  return typeof input === 'string' && input.length > 0 ? input : null;
}

// ─── Persistence layer ───────────────────────────────────────────────────────
//
// NOTE ON PERSISTENCE: the Python module persists to the local filesystem
// under $TNE_DATA/ktap/provenance or ~/.tne/provenance. We mirror that here.
// On svc-temporal this is the worker's local FS — which under the S3-backed
// workspace model is NOT durable across pods unless TNE_DATA points at a
// synced location. This is faithful to the Python behaviour (which also
// assumes a stable local data dir); a durable backing store (S3 / DB) is a
// noted follow-up, same as the Python engine's. See PR body "approximations".

/** Primary provenance root: $TNE_DATA/ktap/provenance, else ~/.tne/provenance. */
export function provenanceRoot(): string {
  const tneData = (process.env.TNE_DATA || '').trim();
  if (tneData) return join(tneData, 'ktap', 'provenance');
  return join(homedir(), '.tne', 'provenance');
}

/** All roots a lookup should check — primary plus the ~/.tne fallback when
 *  they differ (covers the case where TNE_DATA was set on write but a record
 *  also lives in the home fallback, mirroring the Python lookup's dual scan). */
export function provenanceRoots(): string[] {
  const primary = provenanceRoot();
  const alt = join(homedir(), '.tne', 'provenance');
  return primary === alt ? [primary] : [primary, alt];
}

/** Absolute path of the record file for (skill, outputArtifact) under `root`. */
export function recordPath(root: string, skill: string, outputArtifact: string): string {
  return join(root, skill, `${shortHash(outputArtifact)}.json`);
}

// ─── Temporal activities (file I/O) ──────────────────────────────────────────

/**
 * Write a provenance record for a CONVERGED backward execution.
 * Returns the path written, or null on failure (non-fatal, like the Python
 * version which logs + swallows).
 */
export async function recordProvenance(params: {
  skill: string;
  outputArtifact: string;
  inputArtifact: string;
  fidelity: number;
  tier: string;
  repairId?: string | null;
}): Promise<string | null> {
  try {
    const root = join(provenanceRoot(), params.skill);
    await mkdir(root, { recursive: true });
    const path = join(root, `${shortHash(params.outputArtifact)}.json`);
    const record = buildProvenanceRecord({
      skill: params.skill,
      outputArtifact: params.outputArtifact,
      inputArtifact: params.inputArtifact,
      fidelity: params.fidelity,
      tier: params.tier,
      nowIso: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      repairId: params.repairId,
    });
    await writeFile(path, JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return path;
  } catch {
    return null;
  }
}

/**
 * Look up a previously recorded input for the given output artifact.
 * Returns the recorded input text if found, else null. Checks every root
 * (primary + ~/.tne fallback), mirroring the Python `lookup()`.
 */
export async function lookupProvenance(params: {
  skill: string;
  outputArtifact: string;
}): Promise<string | null> {
  for (const root of provenanceRoots()) {
    const path = recordPath(root, params.skill, params.outputArtifact);
    let raw: string | null;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      continue; // missing file in this root → try the next
    }
    const input = selectRecordInput(raw);
    if (input != null) return input;
  }
  return null;
}
