/**
 * Backpropagation utilities — port of tne-plugins'
 * plugins/tne/engine/propagation.py.
 *
 * Pure functions (no I/O, no Temporal SDK calls) so the workflow can call
 * them inside its deterministic event loop without leaving the sandbox.
 * Filesystem-level freshness detection happens in the `checkFreshness`
 * activity; this module deals only with state mutation + DAG math.
 *
 * Vocabulary:
 *   • "stale step" — a previously-COMPLETE step that needs to re-run
 *     because either (a) an evaluator flagged it as the root cause via a
 *     `backprop_to:` marker, or (b) one of its inputs / outputs changed
 *     on disk between runs.
 *   • "forward propagation" — once a step is stale, every transitive
 *     dependent must also re-run so downstream artifacts aren't computed
 *     from outdated inputs.
 */

import type { ProcessConfig, FsmWorkflowState, Step } from '../shared/types.js';
import { StepStatus } from '../shared/types.js';

// ─── Backprop target extraction ─────────────────────────────────────────────

/** Phases the FSM understands as backprop targets. Matches
 *  Python's `propagation._VALID_PHASES`. */
const VALID_PHASES = new Set(['preamble', 'generator', 'evaluator', 'postamble']);

/** Explicit form an evaluator can emit: `backprop_to: preamble.2`. */
const EXPLICIT_RE = /backprop[_-]?to\s*[:=]\s*([a-z]+\.[0-9a-z]+)/i;

/** Inferred patterns — informal evaluator prose. Mirrors Python's
 *  `_BACKPROP_INFER_PATTERNS`: "root cause in <phase> step <num>",
 *  "<phase>\\.<num> is the source", etc. */
const INFER_PATTERNS: RegExp[] = [
  /root\s+cause\s+in\s+(preamble|generator|evaluator|postamble)\s+step\s+([0-9a-z]+)/i,
  /(?:source|origin|culprit)\s+is\s+(preamble|generator|evaluator|postamble)\s+step\s+([0-9a-z]+)/i,
  /(preamble|generator|evaluator|postamble)\s*\.\s*([0-9a-z]+)\s+(?:needs|should|must)\s+(?:to\s+)?(?:be\s+)?(?:re-?run|re-?do)/i,
];

/**
 * Parse evaluator feedback for a backprop target. Returns `null` when no
 * pattern matches — the caller treats that as "no backprop, just iterate
 * normally."
 */
export function extractBackpropTarget(feedback: string): string | null {
  if (!feedback) return null;
  const m = EXPLICIT_RE.exec(feedback);
  if (m) {
    const target = m[1].toLowerCase();
    const [phase] = target.split('.');
    if (VALID_PHASES.has(phase)) return target;
  }
  for (const re of INFER_PATTERNS) {
    const im = re.exec(feedback);
    if (im) {
      const phase = im[1].toLowerCase();
      const number = im[2];
      if (VALID_PHASES.has(phase)) return `${phase}.${number}`;
    }
  }
  return null;
}

// ─── Dependency graph ───────────────────────────────────────────────────────

/**
 * Build a directed dependency graph keyed by step key
 * (`<phase>.<number>`). Edges run from a step → its dependents.
 *
 * Two edge sources:
 *   • **Phase auto-edges**: every generator step depends on every preamble
 *     step; every evaluator on every generator; every postamble on every
 *     evaluator. Mirrors Python's `_build_dag` (lines 43–94).
 *   • **Explicit `dependsOn`**: declared in the SOP table. A dep of
 *     `"2.a"` resolves directly; a bare `"4"` resolves within the same
 *     phase first, then any other phase that has a step with that number.
 *
 * Returns `Map<stepKey, Set<dependentKey>>` — i.e. forward edges.
 */
export function buildDependencyGraph(config: ProcessConfig): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  };

  const phases: Array<{ name: string; steps: Step[] }> = [
    { name: 'preamble', steps: config.preamble },
    { name: 'generator', steps: config.generator },
    { name: 'evaluator', steps: config.evaluator },
    { name: 'postamble', steps: config.postamble },
  ];

  // Initialise every step as a node (even with no outgoing edges).
  for (const { name, steps } of phases) {
    for (const s of steps) adj.set(`${name}.${s.number}`, adj.get(`${name}.${s.number}`) || new Set());
  }

  // Phase auto-edges.
  for (let i = 0; i < phases.length - 1; i++) {
    for (const src of phases[i].steps) {
      for (const dst of phases[i + 1].steps) {
        addEdge(`${phases[i].name}.${src.number}`, `${phases[i + 1].name}.${dst.number}`);
      }
    }
  }

  // Explicit deps from each step's `dependsOn` list.
  for (const { name, steps } of phases) {
    for (const s of steps) {
      const myKey = `${name}.${s.number}`;
      for (const raw of s.dependsOn || []) {
        const dep = raw.trim();
        if (!dep || dep.toLowerCase() === 'all') continue;
        let resolved: string | null = null;
        if (dep.includes('.')) {
          // Qualified: `"generator.4"`
          resolved = dep;
        } else {
          // Bare: prefer same-phase, then scan everywhere.
          const samePhase = `${name}.${dep}`;
          if (adj.has(samePhase)) {
            resolved = samePhase;
          } else {
            for (const ph of phases) {
              const k = `${ph.name}.${dep}`;
              if (adj.has(k)) { resolved = k; break; }
            }
          }
        }
        if (resolved) addEdge(resolved, myKey);
      }
    }
  }

  return adj;
}

/**
 * All transitive dependents of `roots` (BFS over the forward adjacency).
 * `roots` itself is NOT included — only what they reach.
 */
export function descendants(roots: Iterable<string>, dag: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    for (const child of dag.get(r) || []) {
      if (!visited.has(child)) { visited.add(child); queue.push(child); }
    }
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of dag.get(cur) || []) {
      if (!visited.has(child)) { visited.add(child); queue.push(child); }
    }
  }
  return visited;
}

// ─── State mutations ────────────────────────────────────────────────────────

/**
 * Mark every transitive dependent of `staleKeys` as STALE. Returns the set
 * of additional keys flipped (excluding the roots themselves).
 *
 * No-op for keys whose StepState doesn't exist yet (a step that never ran)
 * — we don't conjure entries; the workflow's normal phase loop creates
 * them when it gets there.
 */
export function propagateForward(
  state: FsmWorkflowState,
  staleKeys: Iterable<string>,
  config: ProcessConfig,
): Set<string> {
  const dag = buildDependencyGraph(config);
  const downstream = descendants(staleKeys, dag);
  for (const key of downstream) {
    const ss = state.steps[key];
    if (!ss) continue;
    if (ss.status === StepStatus.COMPLETE || ss.status === StepStatus.AWAITING_REVIEW) {
      ss.status = StepStatus.STALE;
    }
  }
  return downstream;
}

/**
 * End-to-end backprop entry point used by the workflow after the evaluator
 * phase ends with at least one failed evaluator. If the feedback names a
 * target step:
 *   1. Mark the target STALE and stash the feedback on it (so its re-run
 *      gets the evaluator's complaint prepended via collectFeedback).
 *   2. Forward-propagate so all dependents become STALE.
 *
 * Returns the target key (or `null` if no backprop was detected).
 */
export function handleBackprop(
  state: FsmWorkflowState,
  evaluatorFeedback: string,
  config: ProcessConfig,
): string | null {
  const target = extractBackpropTarget(evaluatorFeedback);
  if (!target) return null;
  const ss = state.steps[target];
  if (!ss) return null;
  ss.status = StepStatus.STALE;
  ss.feedback = evaluatorFeedback;
  propagateForward(state, [target], config);
  return target;
}
