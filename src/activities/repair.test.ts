import { describe, it, expect } from 'vitest';
import {
  hashStr,
  RepairMemo,
  headlessCheckpointDecision,
  HEADLESS_ACCEPT_FIDELITY,
  isFixedPoint,
  isAbsorbed,
  FIXED_POINT_FIDELITY,
  ABSORPTION_FIDELITY,
  nodeTerminalFromBackward,
  classifyTerminal,
  applyDecision,
  repairId,
} from './repair.js';

describe('hashStr', () => {
  it('is deterministic and content-sensitive', () => {
    expect(hashStr('abc')).toBe(hashStr('abc'));
    expect(hashStr('abc')).not.toBe(hashStr('abd'));
    expect(hashStr('x')).toHaveLength(64); // sha256 hex
  });
});

describe('RepairMemo (cache hit/miss + hash invalidation)', () => {
  it('HIT when output hash unchanged', () => {
    const memo = new RepairMemo();
    const h = hashStr('out');
    memo.set('p-foo', 'tne-ai', h, 'p-root');
    expect(memo.get('p-foo', 'tne-ai', h)).toBe('p-root');
  });

  it('MISS on a different (skill, org)', () => {
    const memo = new RepairMemo();
    const h = hashStr('out');
    memo.set('p-foo', 'tne-ai', h, 'p-root');
    expect(memo.get('p-bar', 'tne-ai', h)).toBeNull();
    expect(memo.get('p-foo', 'other-org', h)).toBeNull();
  });

  it('INVALIDATES when the output hash changes', () => {
    const memo = new RepairMemo();
    memo.set('p-foo', 'tne-ai', hashStr('v1'), 'p-root');
    // Same skill/org but the upstream output was edited → new hash → miss.
    expect(memo.get('p-foo', 'tne-ai', hashStr('v2'))).toBeNull();
  });

  it('does not collide skill/org that share a substring', () => {
    const memo = new RepairMemo();
    const h = hashStr('out');
    memo.set('a', 'bc', h, 'rootA');
    memo.set('ab', 'c', h, 'rootB');
    expect(memo.get('a', 'bc', h)).toBe('rootA');
    expect(memo.get('ab', 'c', h)).toBe('rootB');
    expect(memo.size).toBe(2);
  });
});

describe('headlessCheckpointDecision', () => {
  it('ACCEPTs at/above the headless fidelity threshold', () => {
    expect(headlessCheckpointDecision(HEADLESS_ACCEPT_FIDELITY)).toBe('ACCEPT');
    expect(headlessCheckpointDecision(0.95)).toBe('ACCEPT');
  });
  it('SKIPs below the threshold', () => {
    expect(headlessCheckpointDecision(0.87)).toBe('SKIP');
    expect(headlessCheckpointDecision(0)).toBe('SKIP');
  });
});

describe('isFixedPoint', () => {
  it('true when candidate hash equals source hash', () => {
    expect(isFixedPoint({ candidate: 'same', source: 'same', bestFidelity: 0 })).toBe(true);
  });
  it('true when fidelity is essentially perfect', () => {
    expect(isFixedPoint({ candidate: 'a', source: 'b', bestFidelity: FIXED_POINT_FIDELITY })).toBe(true);
    expect(isFixedPoint({ candidate: 'a', source: 'b', bestFidelity: 0.999 })).toBe(true);
  });
  it('false otherwise', () => {
    expect(isFixedPoint({ candidate: 'a', source: 'b', bestFidelity: 0.5 })).toBe(false);
  });
});

describe('isAbsorbed', () => {
  it('true when no correction remains to propagate', () => {
    expect(isAbsorbed({ corrections: '', bestFidelity: 0 })).toBe(true);
    expect(isAbsorbed({ corrections: '   ', bestFidelity: 0 })).toBe(true);
  });
  it('true when fidelity reaches the absorption threshold even with a correction', () => {
    expect(isAbsorbed({ corrections: 'fix X', bestFidelity: ABSORPTION_FIDELITY })).toBe(true);
    expect(isAbsorbed({ corrections: 'fix X', bestFidelity: 0.97 })).toBe(true);
  });
  it('false when a correction remains and fidelity is below threshold', () => {
    expect(isAbsorbed({ corrections: 'fix X', bestFidelity: 0.9 })).toBe(false);
  });
});

describe('nodeTerminalFromBackward', () => {
  it('passes through the constrained backward terminal states', () => {
    expect(nodeTerminalFromBackward('CONVERGED')).toBe('CONVERGED');
    expect(nodeTerminalFromBackward('PLATEAUED')).toBe('PLATEAUED');
    expect(nodeTerminalFromBackward('UNCONVERGED')).toBe('UNCONVERGED');
  });
});

describe('applyDecision (USER_CHECKPOINT decision → terminal bucket)', () => {
  it('ACCEPT → CONVERGED, no residual', () => {
    expect(applyDecision('ACCEPT')).toEqual({ terminal: 'CONVERGED', residual: false });
  });
  it('CORRECT → PLATEAUED, no residual', () => {
    expect(applyDecision('CORRECT')).toEqual({ terminal: 'PLATEAUED', residual: false });
  });
  it('SKIP → PLATEAUED, no residual', () => {
    expect(applyDecision('SKIP')).toEqual({ terminal: 'PLATEAUED', residual: false });
  });
  it('REJECT → UNCONVERGED, leaves a residual', () => {
    expect(applyDecision('REJECT')).toEqual({ terminal: 'UNCONVERGED', residual: true });
  });
});

describe('classifyTerminal (overall 4-way classification)', () => {
  it('CONVERGED: some converged, none plateaued, no residual', () => {
    expect(classifyTerminal({ convergedCount: 2, plateauedCount: 0, hasResidual: false })).toBe('CONVERGED');
  });
  it('PARTIAL: converged AND plateaued', () => {
    expect(classifyTerminal({ convergedCount: 1, plateauedCount: 1, hasResidual: false })).toBe('PARTIAL');
  });
  it('PARTIAL: converged AND a residual was emitted', () => {
    expect(classifyTerminal({ convergedCount: 1, plateauedCount: 0, hasResidual: true })).toBe('PARTIAL');
  });
  it('PLATEAUED: nothing converged but something plateaued', () => {
    expect(classifyTerminal({ convergedCount: 0, plateauedCount: 2, hasResidual: false })).toBe('PLATEAUED');
  });
  it('UNCONVERGED: nothing converged, nothing plateaued', () => {
    expect(classifyTerminal({ convergedCount: 0, plateauedCount: 0, hasResidual: true })).toBe('UNCONVERGED');
    expect(classifyTerminal({ convergedCount: 0, plateauedCount: 0, hasResidual: false })).toBe('UNCONVERGED');
  });
});

describe('repairId', () => {
  it('formats {org}-repair-{YYYYMMDDThhmmss} in UTC', () => {
    const d = new Date(Date.UTC(2026, 5, 9, 14, 30, 5)); // 2026-06-09T14:30:05Z
    expect(repairId('tne-ai', d)).toBe('tne-ai-repair-20260609T143005');
  });
  it('zero-pads month/day/time components', () => {
    const d = new Date(Date.UTC(2026, 0, 3, 4, 5, 6));
    expect(repairId('acme', d)).toBe('acme-repair-20260103T040506');
  });
});
