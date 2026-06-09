/**
 * Bidirectional skill execution — the 5-tier PROPOSE_BACKWARD ladder.
 *
 * Port of the Python engine's `backward_dispatch.py` (tne-plugins) for
 * svc-temporal parity. Implements the same ladder:
 *
 *   Tier 0  single-shot LLM pre-flight (cheap fast path; same engine as Tier 4)
 *   Tier 1  Bijection                — declared exact inverse (conditional)
 *   Tier 2  Provenance Replay        — from the provenance store (conditional)
 *   Tier 3  Learned Reverse          — fine-tuned inverse (DEFERRED post-MVP)
 *   Tier 4  LLM Contextual Inversion — SKILL.md + output -> LLM reconstructs input
 *   Tier 5  Blind Draft + Verify     — iterative draft/verify; last resort
 *
 * Tiers 1-3 are conditional on prior artifacts. Most skills fall through to
 * Tier 4 (universal fallback), escalating to Tier 5's convergence loop only
 * when Tier 4's single shot misses the threshold. Tier 3 is deferred (matches
 * Python — `selectTier` collapses "learned"/"lossy" to "contextual").
 *
 * Terminal states: CONVERGED | PLATEAUED | UNCONVERGED.
 *
 * SPLIT (per the svc-temporal convention, like backpropInputs.ts):
 *   - PURE, unit-tested logic: tier detection from SKILL.md frontmatter,
 *     artifact-type thresholds, the convergence/plateau state machine
 *     (`stepConvergence`), parsing an LLM similarity reply, and the ladder
 *     routing decision (`planLadder`). No I/O, no model calls.
 *   - ACTIVITIES (file I/O + Claude Agent SDK): the LLM inversion / blind-draft
 *     tiers and the similarity judge. These are thin; the loop control they
 *     drive is the pure `stepConvergence` above. The Tier 1 bijection
 *     subprocess and the forward-oracle re-run are activities too.
 *
 * The full backward_dispatch() orchestration (Tier 0 pre-flight -> ladder ->
 * Tier 5 loop) is LOGIC-ONLY here in the sense that it is not yet wired into
 * FsmProcessWorkflow — see the PR body. The convergence math it relies on is
 * pure + tested; the per-iteration LLM step is an activity.
 */
import { spawn } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

/** tier0-llm = single-shot fast path; contextual = Tier 4 iterative engine. */
export type TierName =
  | 'tier0-llm'
  | 'bijection'
  | 'provenance'
  | 'learned'
  | 'contextual'
  | 'blind';

export type BackwardTerminalState = 'CONVERGED' | 'PLATEAUED' | 'UNCONVERGED';

export type ArtifactType = 'code' | 'structured' | 'prose' | null;

export interface BackwardResult {
  tier: TierName;
  terminalState: BackwardTerminalState;
  iterations: number;
  roundTripSimilarity: number;
  mergeConfidence: number;
  reconstructedArtifact: string;
  metadata: Record<string, unknown>;
}

// ─── Pure logic (unit-tested) ────────────────────────────────────────────────

/**
 * Artifact-type similarity thresholds (r-cai-bidi91 Principle V). A backward
 * candidate is CONVERGED once its round-trip similarity meets the threshold
 * for its artifact type. Mirrors the Python `_THRESHOLDS` map exactly.
 */
export const THRESHOLDS: Record<string, number> = {
  code: 0.92,
  structured: 0.95,
  prose: 0.88,
  default: 0.9,
};

/** Resolve the convergence threshold for an artifact type. */
export function thresholdFor(artifactType: ArtifactType): number {
  if (artifactType && artifactType in THRESHOLDS) return THRESHOLDS[artifactType];
  return THRESHOLDS.default;
}

/**
 * Detect the highest eligible tier from a SKILL.md's text. Reads the
 * `io: invertible: <tier>` frontmatter (Phase B canonical), falling back to a
 * legacy `PROPOSE_BACKWARD: tier: <tier>` block. Tier 3 ("learned"/"lossy") is
 * deferred post-MVP and collapses to "contextual", matching the Python
 * `_detect_tier`. Unknown / absent declarations also default to "contextual".
 *
 * Pure: takes the SKILL.md text (the file read is the activity's job).
 */
export function selectTier(skillText: string): TierName {
  // Prefer `invertible: <tier>` (Phase B canonical format).
  let m = /^[ \t]*invertible\s*:\s*(\w+)/im.exec(skillText);
  if (!m) {
    // Legacy PROPOSE_BACKWARD block.
    m = /PROPOSE_BACKWARD\s*:\s*\n\s*tier\s*:\s*(\w+)/.exec(skillText);
  }
  if (!m) return 'contextual';
  const declared = m[1].toLowerCase();
  if (declared === 'bijection') return 'bijection';
  if (declared === 'provenance') return 'provenance';
  // "learned" / "lossy" → Tier 3 deferred post-MVP → universal fallback.
  return 'contextual';
}

/**
 * Parse an LLM similarity-judge reply ("Reply with ONLY a decimal …") into a
 * clamped [0,1] score, or null when no number is present (caller then falls
 * back to a string-similarity proxy). Mirrors the Python regex + clamp.
 */
export function parseSimilarityReply(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /([01]?\.\d+|\d+\.?\d*)/.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (Number.isNaN(v)) return null;
  return Math.max(0, Math.min(1, v));
}

/**
 * Deterministic string-similarity proxy in [0,1], used when the LLM judge is
 * unavailable (mirrors the Python difflib.SequenceMatcher fallback). This is
 * the JS analogue: a normalized longest-common-subsequence ratio. It is a
 * PROXY only — see PR body; Python uses difflib which is a slightly different
 * ratio. Provided so pure tests of the loop don't need a live model.
 */
export function similarityProxy(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  // LCS length via rolling DP (O(n*m) time, O(min) space).
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  const prev = new Array<number>(s.length + 1).fill(0);
  const cur = new Array<number>(s.length + 1).fill(0);
  for (let i = 1; i <= t.length; i++) {
    for (let j = 1; j <= s.length; j++) {
      cur[j] = t[i - 1] === s[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= s.length; j++) prev[j] = cur[j];
  }
  const lcs = prev[s.length];
  // difflib's ratio is 2*M / (len(a)+len(b)); use the same shape with LCS as M.
  return (2 * lcs) / (a.length + b.length);
}

/** Running state of the Tier 5 draft/verify convergence loop. */
export interface ConvergenceState {
  bestCandidate: string;
  bestSimilarity: number;
  plateauCount: number;
}

/** A single observation fed into `stepConvergence`. */
export interface ConvergenceStep {
  candidate: string;
  similarity: number;
}

export const PLATEAU_EPS = 0.01; // minimum improvement to avoid PLATEAUED
export const PLATEAU_LIMIT = 2; // consecutive non-improving steps → PLATEAUED

export function initialConvergence(): ConvergenceState {
  return { bestCandidate: '', bestSimilarity: 0, plateauCount: 0 };
}

/**
 * Advance the convergence state machine by one observed iteration — the pure
 * extraction of the Python `_tier5_blind_draft` loop body. Returns the new
 * state plus a terminal verdict for THIS step:
 *   - 'CONVERGED' once bestSimilarity >= threshold
 *   - 'PLATEAUED' once plateauCount >= PLATEAU_LIMIT
 *   - null         → keep iterating (caller decides UNCONVERGED at budget end)
 *
 * Plateau accounting (faithful to Python):
 *   - improvement >= eps        → reset plateauCount to 0
 *   - 0 < improvement < eps     → plateauCount + 1
 *   - similarity <= best (no gain) → plateauCount + 1
 */
export function stepConvergence(
  state: ConvergenceState,
  step: ConvergenceStep,
  threshold: number,
): { state: ConvergenceState; terminal: BackwardTerminalState | null } {
  let { bestCandidate, bestSimilarity, plateauCount } = state;

  if (step.similarity > bestSimilarity) {
    const improvement = step.similarity - bestSimilarity;
    bestSimilarity = step.similarity;
    bestCandidate = step.candidate;
    plateauCount = improvement >= PLATEAU_EPS ? 0 : plateauCount + 1;
  } else {
    plateauCount += 1;
  }

  const next: ConvergenceState = { bestCandidate, bestSimilarity, plateauCount };

  if (bestSimilarity >= threshold) return { state: next, terminal: 'CONVERGED' };
  if (plateauCount >= PLATEAU_LIMIT) return { state: next, terminal: 'PLATEAUED' };
  return { state: next, terminal: null };
}

/**
 * The ladder routing plan: given the detected tier and whether a Tier 0
 * single-shot already converged, decide which tiers to attempt and in what
 * order. Pure extraction of the dispatch decisions in `backward_dispatch`.
 *
 * Returns the ordered list of tier attempts. Tier 0 short-circuits the whole
 * ladder when it converged. Bijection/provenance are attempted only when
 * declared; if they fail (return null at runtime) the orchestrator falls
 * through to 'contextual' then 'blind' — represented here as the tail the
 * orchestrator always appends.
 */
export function planLadder(detectedTier: TierName, tier0Converged: boolean): TierName[] {
  if (tier0Converged) return ['tier0-llm'];
  const plan: TierName[] = [];
  if (detectedTier === 'bijection') plan.push('bijection');
  if (detectedTier === 'provenance') plan.push('provenance');
  // Tier 4 is always the universal fallback; Tier 5 is the escalation tail.
  plan.push('contextual', 'blind');
  return plan;
}

/** Build the Tier 4/5 inverse-reconstruction prompt (mirrors Python's
 *  `_build_inverse_prompt`). Pure — assembles the prompt string from a
 *  SKILL.md excerpt + the output artifact + optional iteration feedback. */
export function buildInversePrompt(params: {
  skillText: string;
  outputArtifact: string;
  iteration: number;
  prevSimilarity: number;
}): string {
  const skillExcerpt = params.skillText.slice(0, 2000);
  const feedback =
    params.iteration > 1
      ? `\n\nPrevious attempt similarity: ${params.prevSimilarity.toFixed(3)}. ` +
        'Adjust your reconstruction to improve round-trip fidelity.'
      : '';
  return (
    'You are a DeltaSkill execution engine. Given the OUTPUT of a skill, ' +
    'reconstruct the most probable INPUT that would produce this output when the ' +
    'skill runs in the forward direction.\n\n' +
    `## Skill context (excerpt)\n\`\`\`\n${skillExcerpt}\n\`\`\`\n\n` +
    `## Output artifact to invert\n\`\`\`\n${params.outputArtifact.slice(0, 4000)}\n\`\`\`\n\n` +
    `${feedback}` +
    '\n\nReturn ONLY the reconstructed input. No preamble or explanation.'
  );
}

const SIMILARITY_PROMPT = (a: string, b: string): string =>
  `Rate the semantic similarity between Text A and Text B on a scale from 0.00 to 1.00.

0.00 = completely unrelated
0.50 = partially related, same domain
0.90 = nearly identical meaning, minor wording differences
1.00 = same meaning, same content

Text A:
${a.slice(0, 2000)}

Text B:
${b.slice(0, 2000)}

Reply with ONLY a decimal number between 0.00 and 1.00. No explanation.`;

// ─── Activities (LLM via Claude Agent SDK + subprocess I/O) ──────────────────

/** Model used for the inversion + similarity LLM steps. Overridable via env. */
const BACKWARD_MODEL = process.env.BACKWARD_MODEL?.trim() || 'claude-sonnet-4-5-20250929';

/** Drain a Claude Agent SDK query into a single text string. Mirrors the
 *  collection loop in runGateCascade / invokeSkill. */
async function collectAgentText(prompt: string, cwd: string, maxTurns: number): Promise<string> {
  const { createClaudeSDKAgent } = await import('../services/claudeSdkAgent.js');
  const agent = createClaudeSDKAgent({
    model: BACKWARD_MODEL,
    cwd,
    permissionMode: 'bypassPermissions',
    maxTurns,
    allowedTools: [],
  });
  let text = '';
  for await (const event of agent.query(prompt)) {
    const ev = event as any;
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
      }
    } else if (ev?.type === 'result' && typeof ev.result === 'string' && !text) {
      text = ev.result;
    }
  }
  return text.trim();
}

/**
 * ACTIVITY: LLM similarity judge with a deterministic proxy fallback.
 * Mirrors Python's `_similarity`. Returns a score in [0,1].
 */
export async function judgeSimilarity(params: {
  a: string;
  b: string;
  cwd?: string;
}): Promise<number> {
  try {
    const text = await collectAgentText(SIMILARITY_PROMPT(params.a, params.b), params.cwd || process.cwd(), 3);
    const parsed = parseSimilarityReply(text);
    if (parsed != null) return parsed;
  } catch {
    /* fall through to proxy */
  }
  return similarityProxy(params.a, params.b);
}

/**
 * ACTIVITY: single LLM contextual-inversion turn (Tier 0 / Tier 4 / Tier 5).
 * Returns the reconstructed-input candidate, or null when the model produced
 * nothing. Mirrors Python's `_invoke_llm` over `_build_inverse_prompt`.
 */
export async function llmInvert(params: {
  skillText: string;
  outputArtifact: string;
  iteration: number;
  prevSimilarity: number;
  cwd?: string;
}): Promise<string | null> {
  const prompt = buildInversePrompt({
    skillText: params.skillText,
    outputArtifact: params.outputArtifact,
    iteration: params.iteration,
    prevSimilarity: params.prevSimilarity,
  });
  try {
    const out = await collectAgentText(prompt, params.cwd || process.cwd(), 5);
    return out || null;
  } catch {
    return null;
  }
}

/**
 * ACTIVITY: Tier 1 bijection — run a skill's declared `inverse_fn` script.
 * Mirrors Python's `_tier1_bijection`: parse `inverse_fn: <path>` from the
 * SKILL.md text, run it as a subprocess feeding the output on stdin, return
 * stdout (or null on any failure → caller falls through to Tier 4).
 */
export async function runBijectionInverse(params: {
  skillText: string;
  skillDir: string;
  outputArtifact: string;
}): Promise<string | null> {
  const m = /inverse_fn\s*:\s*(.+)/.exec(params.skillText);
  if (!m) return null;
  const { isAbsolute, join } = await import('path');
  const { existsSync } = await import('fs');
  const rel = m[1].trim();
  const inverseFn = isAbsolute(rel) ? rel : join(params.skillDir, rel);
  if (!existsSync(inverseFn)) return null;

  return new Promise<string | null>((resolve) => {
    const proc = spawn('python', [inverseFn], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    proc.stdin.write(params.outputArtifact);
    proc.stdin.end();
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve(null);
    }, 300_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
