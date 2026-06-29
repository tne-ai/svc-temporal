import { describe, it, expect } from 'vitest';
import { isDepSatisfied, isDepBlockedByFailure } from './depResolution.js';
import { StepStatus, type Step } from '../shared/types.js';

const mk = (number: string): Step => ({ number } as unknown as Step);

// Reproduces the council postamble: finalize(1) -> gate(2) -> render(3).
const postamble = [mk('1'), mk('2'), mk('3')];

// Earlier phases all COMPLETE — every phase has a `.1`, and generator has `.2`.
// This is what makes the bare-number collision possible.
const earlierComplete: Record<string, { status: StepStatus }> = {
  'preamble.1': { status: StepStatus.COMPLETE },
  'generator.1': { status: StepStatus.COMPLETE },
  'generator.2': { status: StepStatus.COMPLETE },
  'evaluator.1': { status: StepStatus.COMPLETE },
};

describe('isDepSatisfied — intra-phase deps must not collide with earlier phases', () => {
  it('REGRESSION: gate dep on local "1" (finalize) is UNSATISFIED until finalize completes, despite preamble.1/generator.1/evaluator.1 COMPLETE', () => {
    // Pre-fix this returned true (matched generator.1 via endsWith), so the gate
    // raced finalize and reported "no run persisted".
    expect(isDepSatisfied({ kind: 'num', number: '1' }, '2', postamble, new Set(), earlierComplete)).toBe(false);
  });

  it('gate dep on "1" becomes satisfied once finalize (local postamble.1) completes', () => {
    expect(isDepSatisfied({ kind: 'num', number: '1' }, '2', postamble, new Set(['1']), earlierComplete)).toBe(true);
  });

  it('render dep on local "2" (gate) stays unsatisfied until the gate completes, despite generator.2 COMPLETE', () => {
    expect(isDepSatisfied({ kind: 'num', number: '2' }, '3', postamble, new Set(['1']), earlierComplete)).toBe(false);
  });

  it('preserves the cross-phase fallback: a bare number NOT present in this phase resolves against another phase', () => {
    const state = { ...earlierComplete, 'generator.4': { status: StepStatus.COMPLETE } };
    expect(isDepSatisfied({ kind: 'num', number: '4' }, '1', postamble, new Set(), state)).toBe(true);
  });

  it('qualified deps resolve directly against the named phase.step', () => {
    expect(isDepSatisfied({ kind: 'qual', phase: 'generator', number: '1' }, '1', postamble, new Set(), earlierComplete)).toBe(true);
    expect(isDepSatisfied({ kind: 'qual', phase: 'generator', number: '9' }, '1', postamble, new Set(), earlierComplete)).toBe(false);
  });
});

describe('isDepBlockedByFailure — symmetric same-phase-first', () => {
  it('REGRESSION: a local dep on "1" is NOT blocked by a failed earlier-phase generator.1', () => {
    expect(isDepBlockedByFailure({ kind: 'num', number: '1' }, '2', postamble, new Set(), new Set(), { 'generator.1': { status: StepStatus.FAILED } })).toBe(false);
  });

  it('a local dep on "1" IS blocked when local postamble.1 (finalize) failed', () => {
    expect(isDepBlockedByFailure({ kind: 'num', number: '1' }, '2', postamble, new Set(['1']), new Set(), {})).toBe(true);
  });

  it('a cross-phase bare number (not in this phase) IS blocked by that phase failing', () => {
    expect(isDepBlockedByFailure({ kind: 'num', number: '4' }, '1', postamble, new Set(), new Set(), { 'generator.4': { status: StepStatus.FAILED } })).toBe(true);
  });
});
