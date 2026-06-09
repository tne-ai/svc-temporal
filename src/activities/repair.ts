/**
 * REPAIR — bidirectional (backward -> forward) graph execution control.
 *
 * Port of the Python engine's `repair.py` (tne-plugins) for svc-temporal
 * parity. The Python REPAIR model:
 *
 *   Phase 1 — Backward: walk upstream from start_skill until a fixed point.
 *     LOOP (max_iterations_backward):
 *       candidate = backward_dispatch(current, output, corrections)
 *       USER_CHECKPOINT -> ACCEPT / CORRECT(delta) / SKIP / REJECT
 *       fixed point: candidate ~= source  -> this node IS the root
 *   Phase 2 — Forward: from the root, sweep downstream (parallel branches).
 *
 * Efficiency primitives (all ported here as PURE, tested logic):
 *   - Absorption detection: stop backward early when the correction is
 *     absorbed mid-graph (fidelity high enough / no remaining correction).
 *   - Fixed-point detection: candidate hash == source hash, or fidelity ~1.
 *   - Memo cache: (skill, org) -> {root, outputHash}; invalidated on hash change.
 *   - Terminal-state classification: CONVERGED | PLATEAUED | UNCONVERGED | PARTIAL.
 *
 * SPLIT (per the svc-temporal convention):
 *   - PURE, unit-tested logic (this file's first section): the memo cache, the
 *     hash helper, the headless USER_CHECKPOINT auto-decision, fixed-point +
 *     absorption detection, the per-node terminal verdict, and the overall
 *     4-way terminal classification.
 *   - ORCHESTRATION (the full `repair()` Phase-1/Phase-2 traversal that runs
 *     skills, reads/writes candidate files, presents the checkpoint, and
 *     sweeps the graph) is NOT ported as a runnable activity yet — it depends
 *     on the skill graph loader, forward skill invocation, and the
 *     FsmProcessWorkflow "backward phase" wiring. That wiring is a follow-up
 *     (see PR body). The decision functions it will call are all here + tested.
 */
import { createHash } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TerminalState = 'CONVERGED' | 'PLATEAUED' | 'UNCONVERGED' | 'PARTIAL';
export type Direction = 'forward' | 'backward';
export type UserDecision = 'ACCEPT' | 'CORRECT' | 'SKIP' | 'REJECT';

export interface RepairNode {
  skill: string;
  org: string;
  outputPath: string;
  direction: Direction;
  terminalState: TerminalState | null;
  candidatePath?: string | null;
  fidelity: number;
  iterations: number;
}

// ─── Hash helper (pure) ──────────────────────────────────────────────────────

/** SHA-256 hex of a string — used for fixed-point + memo invalidation. */
export function hashStr(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

// ─── Memo cache (pure) ───────────────────────────────────────────────────────
//
// (skill, org) -> {root, outputHash}. A cache hit is valid only while the
// output hash is unchanged — when the upstream output is edited the hash
// changes and the cached root is invalidated. Mirrors Python's `_memo`.

export interface MemoEntry {
  root: string;
  outputHash: string;
}

export class RepairMemo {
  private store = new Map<string, MemoEntry>();

  private key(skill: string, org: string): string {
    // Tab is illegal in skill/org slugs, so it's a safe composite delimiter.
    return `${skill}\t${org}`;
  }

  /** Return the cached root iff the output hash is unchanged, else null. */
  get(skill: string, org: string, outputHash: string): string | null {
    const entry = this.store.get(this.key(skill, org));
    if (entry && entry.outputHash === outputHash) return entry.root;
    return null;
  }

  set(skill: string, org: string, outputHash: string, root: string): void {
    this.store.set(this.key(skill, org), { root, outputHash });
  }

  /** Test/introspection helper — number of cached entries. */
  get size(): number {
    return this.store.size;
  }
}

// ─── USER_CHECKPOINT headless auto-decision (pure) ───────────────────────────

/** Headless ACCEPT threshold — fidelity at/above this auto-accepts, else SKIP.
 *  Matches the Python `UserCheckpoint.present()` headless branch (>= 0.88). */
export const HEADLESS_ACCEPT_FIDELITY = 0.88;

/**
 * The headless USER_CHECKPOINT decision for one pending candidate: auto-ACCEPT
 * when fidelity >= HEADLESS_ACCEPT_FIDELITY, else SKIP. Pure — the interactive
 * branch (terminal prompt) is intentionally not ported (no TTY in a worker).
 */
export function headlessCheckpointDecision(fidelity: number): UserDecision {
  return fidelity >= HEADLESS_ACCEPT_FIDELITY ? 'ACCEPT' : 'SKIP';
}

// ─── Fixed-point + absorption detection (pure) ───────────────────────────────

/** Fidelity at/above which a node is treated as a fixed point (candidate ~=
 *  source). Mirrors Python's `best_fidelity >= 0.99`. */
export const FIXED_POINT_FIDELITY = 0.99;

/** Fidelity at/above which a correction is considered fully absorbed at the
 *  current node. Mirrors Python's `best_fidelity >= 0.95`. */
export const ABSORPTION_FIDELITY = 0.95;

/**
 * Fixed-point detection: the reconstructed candidate equals the source (by
 * hash), OR the best fidelity is essentially perfect. When true, the current
 * node IS the root and backward traversal stops. Mirrors the Python check
 * `cand_hash == output_hash or best_fidelity >= 0.99`.
 */
export function isFixedPoint(params: {
  candidate: string;
  source: string;
  bestFidelity: number;
}): boolean {
  if (params.bestFidelity >= FIXED_POINT_FIDELITY) return true;
  return hashStr(params.candidate) === hashStr(params.source);
}

/**
 * Absorption detection: the correction has been fully absorbed at this node —
 * either there is no outstanding correction to propagate further upstream, or
 * fidelity is high enough that nothing meaningful remains. Mirrors the Python
 * check `not current_corrections or best_fidelity >= 0.95`. When true, the
 * current node is the root (the change doesn't need to climb further).
 */
export function isAbsorbed(params: { corrections: string; bestFidelity: number }): boolean {
  if (!params.corrections || params.corrections.trim().length === 0) return true;
  return params.bestFidelity >= ABSORPTION_FIDELITY;
}

// ─── Per-node + overall terminal classification (pure) ───────────────────────

/**
 * The per-node backward verdict given the inner backward_dispatch terminal
 * state. The Python inner loop breaks on CONVERGED or PLATEAUED; otherwise it
 * is UNCONVERGED at budget end. This is a thin, total mapping so callers don't
 * special-case the (already constrained) backward terminal states.
 */
export function nodeTerminalFromBackward(
  state: 'CONVERGED' | 'PLATEAUED' | 'UNCONVERGED',
): TerminalState {
  return state;
}

/**
 * Overall REPAIR terminal classification — the exact 4-way decision from the
 * tail of Python's `repair()` (lines 779-786):
 *
 *   converged && !plateaued && !residual           -> CONVERGED
 *   converged && (plateaued || residual)            -> PARTIAL
 *   !converged && plateaued                          -> PLATEAUED
 *   otherwise (nothing converged, nothing plateaued) -> UNCONVERGED
 *
 * A "residual" is emitted whenever a node ends PLATEAUED/UNCONVERGED or a user
 * REJECTs — `hasResidual` captures that the run left unresolved work behind.
 */
export function classifyTerminal(params: {
  convergedCount: number;
  plateauedCount: number;
  hasResidual: boolean;
}): TerminalState {
  const { convergedCount, plateauedCount, hasResidual } = params;
  if (convergedCount > 0 && plateauedCount === 0 && !hasResidual) return 'CONVERGED';
  if (convergedCount > 0 && (plateauedCount > 0 || hasResidual)) return 'PARTIAL';
  if (convergedCount === 0 && plateauedCount > 0) return 'PLATEAUED';
  return 'UNCONVERGED';
}

/**
 * Apply a USER_CHECKPOINT decision to a node's terminal state, classifying it
 * into the converged / plateaued buckets the overall classifier counts.
 * Mirrors the Python decision dispatch in `repair()`:
 *   ACCEPT  -> CONVERGED (promote candidate)
 *   CORRECT -> PLATEAUED (re-queue with correction)
 *   SKIP    -> PLATEAUED
 *   REJECT  -> UNCONVERGED (+ residual)
 *
 * Returns the resolved terminal state and whether it contributes a residual.
 */
export function applyDecision(decision: UserDecision): {
  terminal: TerminalState;
  residual: boolean;
} {
  switch (decision) {
    case 'ACCEPT':
      return { terminal: 'CONVERGED', residual: false };
    case 'CORRECT':
      return { terminal: 'PLATEAUED', residual: false };
    case 'SKIP':
      return { terminal: 'PLATEAUED', residual: false };
    case 'REJECT':
    default:
      return { terminal: 'UNCONVERGED', residual: true };
  }
}

// ─── repair_id (pure-ish — deterministic given a timestamp) ──────────────────

/** Build the repair-run id `{org}-repair-{YYYYMMDDThhmmss}` from a Date.
 *  Mirrors Python's `_repair_id` (UTC, second precision). */
export function repairId(org: string, now: Date): string {
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  const ts =
    `${now.getUTCFullYear()}${z(now.getUTCMonth() + 1)}${z(now.getUTCDate())}` +
    `T${z(now.getUTCHours())}${z(now.getUTCMinutes())}${z(now.getUTCSeconds())}`;
  return `${org}-repair-${ts}`;
}
