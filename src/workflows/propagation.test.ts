import { describe, it, expect } from 'vitest';
import {
  extractBackpropTarget,
  buildDependencyGraph,
  descendants,
  propagateForward,
  handleBackprop,
} from './propagation.js';
import {
  StepStatus,
  EvaluatorMode,
  StageType,
  type ProcessConfig,
  type FsmWorkflowState,
  type Step,
  Phase,
} from '../shared/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────

function mkStep(number: string, opts: Partial<Step> = {}): Step {
  return {
    number,
    skill: opts.skill ?? `s-${number}`,
    inputs: opts.inputs ?? [],
    output: opts.output ?? '',
    verify: '',
    run: '',
    notes: '',
    passCondition: '',
    stageType: StageType.DEFAULT,
    dependsOn: opts.dependsOn ?? [],
    backpropSkill: opts.backpropSkill ?? '',
    failFast: { maxRetries: 0, gates: [] },
    permissionMode: '',
    model: '',
    timeout: 0,
    tneEngine: false,
    tneEngineMaxIterations: 3,
  };
}

function mkConfig(opts: {
  preamble?: Step[];
  generator?: Step[];
  evaluator?: Step[];
  postamble?: Step[];
}): ProcessConfig {
  return {
    scope: 'test',
    maxIterations: 5,
    evaluatorMode: EvaluatorMode.FAIL_FAST,
    completionThreshold: '',
    parentScope: '',
    approvalGate: false,
    userCheckpoint: false,
    stageReview: false,
    perStepReview: true,
    preFlightInputs: [],
    inputsFile: '',
    inputsBackprop: false,
    inputsBackpropGate: '',
    parallelGenerator: false,
    preamble: opts.preamble ?? [],
    generator: opts.generator ?? [],
    evaluator: opts.evaluator ?? [],
    postamble: opts.postamble ?? [],
    finalization: [],
    council: [],
    vars: {},
  };
}

function mkState(config: ProcessConfig, completed: string[] = []): FsmWorkflowState {
  const steps: FsmWorkflowState['steps'] = {};
  for (const [phaseName, list] of Object.entries({
    preamble: config.preamble,
    generator: config.generator,
    evaluator: config.evaluator,
    postamble: config.postamble,
  })) {
    for (const s of list) {
      const key = `${phaseName}.${s.number}`;
      steps[key] = {
        status: completed.includes(key) ? StepStatus.COMPLETE : StepStatus.PENDING,
        retries: 0,
      };
    }
  }
  return { phase: Phase.GENERATOR, iteration: 1, steps, iterations: [], earlyExit: false };
}

// ── extractBackpropTarget ────────────────────────────────────────────

describe('extractBackpropTarget', () => {
  it('parses explicit colon form: backprop_to: preamble.2', () => {
    expect(extractBackpropTarget('backprop_to: preamble.2')).toBe('preamble.2');
  });

  it('parses equals form + case-insensitive phase', () => {
    expect(extractBackpropTarget('Backprop_To = GENERATOR.4')).toBe('generator.4');
  });

  it('parses hyphen variant', () => {
    expect(extractBackpropTarget('backprop-to: evaluator.1')).toBe('evaluator.1');
  });

  it('infers "root cause in preamble step 2"', () => {
    expect(extractBackpropTarget('The root cause in preamble step 2 is bad input data.')).toBe('preamble.2');
  });

  it('infers "<phase>.<n> needs to be re-run"', () => {
    expect(extractBackpropTarget('preamble.3 needs to be re-run with better inputs')).toBe('preamble.3');
  });

  it('returns null on free-form feedback that does not name a step', () => {
    expect(extractBackpropTarget('Looks fine but the tone is off.')).toBeNull();
    expect(extractBackpropTarget('')).toBeNull();
  });

  it('rejects unknown phases', () => {
    expect(extractBackpropTarget('backprop_to: wibble.7')).toBeNull();
  });

  it('handles alphanumeric step numbers like "2.a"', () => {
    expect(extractBackpropTarget('backprop_to: generator.2a')).toBe('generator.2a');
  });
});

// ── buildDependencyGraph + descendants ──────────────────────────────

describe('buildDependencyGraph', () => {
  it('emits phase auto-edges only when phases are non-empty', () => {
    const cfg = mkConfig({
      preamble: [mkStep('1')],
      generator: [mkStep('1'), mkStep('2')],
      evaluator: [mkStep('1')],
    });
    const dag = buildDependencyGraph(cfg);
    // Every preamble step → every generator step
    expect(dag.get('preamble.1')).toEqual(new Set(['generator.1', 'generator.2']));
    // Every generator step → every evaluator step
    expect(dag.get('generator.1')).toEqual(new Set(['evaluator.1']));
    expect(dag.get('generator.2')).toEqual(new Set(['evaluator.1']));
    // Evaluator has no successors here (no postamble defined)
    expect(dag.get('evaluator.1')).toEqual(new Set());
  });

  it('resolves explicit qualified deps (generator.4 → postamble.1)', () => {
    const cfg = mkConfig({
      generator: [mkStep('4')],
      postamble: [mkStep('1', { dependsOn: ['generator.4'] })],
    });
    const dag = buildDependencyGraph(cfg);
    expect(dag.get('generator.4')?.has('postamble.1')).toBe(true);
  });

  it('resolves bare deps within the same phase first', () => {
    const cfg = mkConfig({
      generator: [mkStep('1'), mkStep('2', { dependsOn: ['1'] })],
    });
    const dag = buildDependencyGraph(cfg);
    expect(dag.get('generator.1')?.has('generator.2')).toBe(true);
  });

  it('falls back to cross-phase search when same-phase dep is missing', () => {
    const cfg = mkConfig({
      preamble: [mkStep('9')],
      generator: [mkStep('1', { dependsOn: ['9'] })],
    });
    const dag = buildDependencyGraph(cfg);
    // Phase auto-edge already covers this, but the explicit dep should
    // not crash on resolution.
    expect(dag.get('preamble.9')?.has('generator.1')).toBe(true);
  });
});

describe('descendants', () => {
  it('walks the DAG transitively', () => {
    const cfg = mkConfig({
      preamble: [mkStep('1')],
      generator: [mkStep('1'), mkStep('2')],
      evaluator: [mkStep('1')],
      postamble: [mkStep('1')],
    });
    const dag = buildDependencyGraph(cfg);
    const reached = descendants(['preamble.1'], dag);
    expect(reached.has('generator.1')).toBe(true);
    expect(reached.has('generator.2')).toBe(true);
    expect(reached.has('evaluator.1')).toBe(true);
    expect(reached.has('postamble.1')).toBe(true);
    // Roots themselves are excluded
    expect(reached.has('preamble.1')).toBe(false);
  });
});

// ── propagateForward ────────────────────────────────────────────────

describe('propagateForward', () => {
  it('marks COMPLETE downstream steps STALE; leaves PENDING ones alone', () => {
    const cfg = mkConfig({
      preamble: [mkStep('1')],
      generator: [mkStep('1')],
      evaluator: [mkStep('1')],
    });
    const state = mkState(cfg, ['preamble.1', 'generator.1']);
    // evaluator.1 is still PENDING (never ran)
    propagateForward(state, ['preamble.1'], cfg);
    expect(state.steps['generator.1'].status).toBe(StepStatus.STALE);
    // PENDING stays PENDING — workflow's normal phase loop will handle it
    expect(state.steps['evaluator.1'].status).toBe(StepStatus.PENDING);
  });

  it('flips AWAITING_REVIEW → STALE so a pending human gate is reopened', () => {
    const cfg = mkConfig({
      preamble: [mkStep('1'), mkStep('2', { dependsOn: ['1'] })],
    });
    const state = mkState(cfg);
    state.steps['preamble.1'].status = StepStatus.COMPLETE;
    state.steps['preamble.2'].status = StepStatus.AWAITING_REVIEW;
    propagateForward(state, ['preamble.1'], cfg);
    expect(state.steps['preamble.2'].status).toBe(StepStatus.STALE);
  });
});

// ── handleBackprop ──────────────────────────────────────────────────

describe('handleBackprop', () => {
  it('marks target STALE + stashes feedback + cascades to dependents', () => {
    const cfg = mkConfig({
      preamble: [mkStep('2')],
      generator: [mkStep('1')],
      evaluator: [mkStep('1')],
    });
    const state = mkState(cfg, ['preamble.2', 'generator.1', 'evaluator.1']);
    const fb = 'backprop_to: preamble.2 — the source data was wrong.';
    const target = handleBackprop(state, fb, cfg);
    expect(target).toBe('preamble.2');
    expect(state.steps['preamble.2'].status).toBe(StepStatus.STALE);
    expect(state.steps['preamble.2'].feedback).toBe(fb);
    // Dependents flipped too
    expect(state.steps['generator.1'].status).toBe(StepStatus.STALE);
    expect(state.steps['evaluator.1'].status).toBe(StepStatus.STALE);
  });

  it('no-op when feedback names no target', () => {
    const cfg = mkConfig({ preamble: [mkStep('1')] });
    const state = mkState(cfg, ['preamble.1']);
    expect(handleBackprop(state, 'just a stylistic nit', cfg)).toBeNull();
    expect(state.steps['preamble.1'].status).toBe(StepStatus.COMPLETE);
  });

  it('returns null when target step does not exist in state', () => {
    const cfg = mkConfig({ preamble: [mkStep('1')] });
    const state = mkState(cfg, ['preamble.1']);
    expect(handleBackprop(state, 'backprop_to: preamble.99', cfg)).toBeNull();
  });
});
