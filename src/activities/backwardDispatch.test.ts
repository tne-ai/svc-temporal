import { describe, it, expect } from 'vitest';
import {
  THRESHOLDS,
  thresholdFor,
  selectTier,
  parseSimilarityReply,
  similarityProxy,
  initialConvergence,
  stepConvergence,
  planLadder,
  buildInversePrompt,
  PLATEAU_LIMIT,
} from './backwardDispatch.js';

describe('thresholdFor', () => {
  it('returns the per-artifact-type threshold', () => {
    expect(thresholdFor('code')).toBe(THRESHOLDS.code);
    expect(thresholdFor('structured')).toBe(0.95);
    expect(thresholdFor('prose')).toBe(0.88);
  });
  it('falls back to default for null/unknown', () => {
    expect(thresholdFor(null)).toBe(0.9);
    expect(thresholdFor('weird' as any)).toBe(0.9);
  });
});

describe('selectTier (tier detection from SKILL.md)', () => {
  it('reads io: invertible: bijection (canonical)', () => {
    const md = 'io:\n  invertible: bijection\n';
    expect(selectTier(md)).toBe('bijection');
  });
  it('reads invertible: provenance', () => {
    expect(selectTier('  invertible: provenance')).toBe('provenance');
  });
  it('defers learned/lossy (Tier 3) to contextual (universal fallback)', () => {
    expect(selectTier('invertible: learned')).toBe('contextual');
    expect(selectTier('invertible: lossy')).toBe('contextual');
  });
  it('reads the legacy PROPOSE_BACKWARD block', () => {
    const md = 'PROPOSE_BACKWARD:\n  tier: bijection\n';
    expect(selectTier(md)).toBe('bijection');
  });
  it('defaults to contextual when no declaration is present', () => {
    expect(selectTier('# just a skill\nno frontmatter here')).toBe('contextual');
  });
  it('defaults to contextual for an unrecognized tier word', () => {
    expect(selectTier('invertible: banana')).toBe('contextual');
  });
});

describe('parseSimilarityReply', () => {
  it('parses a bare decimal', () => {
    expect(parseSimilarityReply('0.93')).toBe(0.93);
    expect(parseSimilarityReply('  0.5 \n')).toBe(0.5);
  });
  it('extracts the first number from chatty output', () => {
    expect(parseSimilarityReply('I think it is 0.88 similar')).toBe(0.88);
  });
  it('clamps over-range values to 1', () => {
    expect(parseSimilarityReply('1.5')).toBe(1);
  });
  it('ignores a leading minus (regex matches the unsigned number, like Python)', () => {
    // The Python regex `([01]?\.\d+|\d+\.?\d*)` matches "0.2" out of "-0.2".
    expect(parseSimilarityReply('-0.2')).toBe(0.2);
  });
  it('returns null when no number present', () => {
    expect(parseSimilarityReply('no idea')).toBeNull();
    expect(parseSimilarityReply(null)).toBeNull();
    expect(parseSimilarityReply('')).toBeNull();
  });
});

describe('similarityProxy', () => {
  it('is 1.0 for identical strings', () => {
    expect(similarityProxy('abc', 'abc')).toBe(1);
  });
  it('is 0 when one side is empty', () => {
    expect(similarityProxy('abc', '')).toBe(0);
  });
  it('is between 0 and 1 for partial overlap and monotonic-ish', () => {
    const partial = similarityProxy('the quick brown fox', 'the quick red fox');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
    // closer strings score higher than disjoint ones
    expect(partial).toBeGreaterThan(similarityProxy('the quick brown fox', 'zzzzz'));
  });
});

describe('stepConvergence (Tier 5 loop state machine)', () => {
  it('CONVERGED once best similarity meets threshold', () => {
    const r = stepConvergence(initialConvergence(), { candidate: 'X', similarity: 0.95 }, 0.9);
    expect(r.terminal).toBe('CONVERGED');
    expect(r.state.bestSimilarity).toBe(0.95);
    expect(r.state.bestCandidate).toBe('X');
  });

  it('keeps iterating (null) while below threshold and improving', () => {
    let s = initialConvergence();
    let r = stepConvergence(s, { candidate: 'a', similarity: 0.5 }, 0.9);
    expect(r.terminal).toBeNull();
    expect(r.state.plateauCount).toBe(0); // 0.5 > 0 by >= eps → reset
    r = stepConvergence(r.state, { candidate: 'b', similarity: 0.7 }, 0.9);
    expect(r.terminal).toBeNull();
    expect(r.state.plateauCount).toBe(0);
    expect(r.state.bestCandidate).toBe('b');
  });

  it('PLATEAUED after PLATEAU_LIMIT non-improving steps', () => {
    let s = initialConvergence();
    // First a real gain.
    let r = stepConvergence(s, { candidate: 'a', similarity: 0.6 }, 0.99);
    expect(r.terminal).toBeNull();
    // Two steps with no improvement (similarity not greater than best).
    r = stepConvergence(r.state, { candidate: 'b', similarity: 0.6 }, 0.99);
    expect(r.state.plateauCount).toBe(1);
    expect(r.terminal).toBeNull();
    r = stepConvergence(r.state, { candidate: 'c', similarity: 0.59 }, 0.99);
    expect(r.state.plateauCount).toBe(PLATEAU_LIMIT);
    expect(r.terminal).toBe('PLATEAUED');
  });

  it('counts a sub-eps improvement toward plateau (faithful to Python)', () => {
    let s = initialConvergence();
    let r = stepConvergence(s, { candidate: 'a', similarity: 0.6 }, 0.99);
    expect(r.state.plateauCount).toBe(0);
    // +0.005 < eps(0.01) → improvement but plateauCount increments
    r = stepConvergence(r.state, { candidate: 'b', similarity: 0.605 }, 0.99);
    expect(r.state.bestSimilarity).toBeCloseTo(0.605);
    expect(r.state.plateauCount).toBe(1);
    expect(r.terminal).toBeNull();
  });
});

describe('planLadder (ladder routing decision)', () => {
  it('short-circuits to tier0 when the single-shot converged', () => {
    expect(planLadder('contextual', true)).toEqual(['tier0-llm']);
    expect(planLadder('bijection', true)).toEqual(['tier0-llm']);
  });
  it('contextual skill → contextual then blind tail', () => {
    expect(planLadder('contextual', false)).toEqual(['contextual', 'blind']);
  });
  it('bijection skill → bijection first, then contextual + blind fallback', () => {
    expect(planLadder('bijection', false)).toEqual(['bijection', 'contextual', 'blind']);
  });
  it('provenance skill → provenance first, then contextual + blind fallback', () => {
    expect(planLadder('provenance', false)).toEqual(['provenance', 'contextual', 'blind']);
  });
});

describe('buildInversePrompt', () => {
  it('includes skill excerpt + output and no feedback on iteration 1', () => {
    const p = buildInversePrompt({ skillText: 'SKILL BODY', outputArtifact: 'OUT', iteration: 1, prevSimilarity: 0 });
    expect(p).toContain('SKILL BODY');
    expect(p).toContain('OUT');
    expect(p).toContain('Return ONLY the reconstructed input');
    expect(p).not.toContain('Previous attempt similarity');
  });
  it('adds prior-similarity feedback on iteration > 1', () => {
    const p = buildInversePrompt({ skillText: 's', outputArtifact: 'o', iteration: 2, prevSimilarity: 0.42 });
    expect(p).toContain('Previous attempt similarity: 0.420');
  });
  it('truncates very long skill text and output', () => {
    const p = buildInversePrompt({
      skillText: 'x'.repeat(5000),
      outputArtifact: 'y'.repeat(9000),
      iteration: 1,
      prevSimilarity: 0,
    });
    expect(p).toContain('x'.repeat(2000));
    expect(p).not.toContain('x'.repeat(2001));
    expect(p).toContain('y'.repeat(4000));
    expect(p).not.toContain('y'.repeat(4001));
  });
});
