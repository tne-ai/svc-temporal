/**
 * Gate 1 (type-specific quality gate) parity tests.
 *
 * Mirrors the Python engine's `_run_gate1` dispatch in
 * tne-plugins/plugins/tne/engine/gates.py (the gate that runs FIRST,
 * dispatched by `step.stageType`). Covers:
 *   - CREATIVE      → auto-pass (gates.py:136-141)
 *   - CODE          → non-empty check (gates.py:150-158)
 *   - ANALYSIS/DEFAULT → structure check (gates.py:160-182, ported loosely:
 *                     svc-temporal's gate1StructureCheck only requires
 *                     non-empty — see note in runGateCascade.ts:199-203)
 *   - FACT_SEARCH   → LLM/harness gate (gates.py:143-148), mocked here
 * Plus cascade-level fail-fast / dry-run / missing-file behavior.
 *
 * The Claude Agent SDK gate call is mocked — no real model is hit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { StageType, type Step } from '../shared/types.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────
// heartbeat() throws outside a Temporal activity context; stub it to a no-op.
vi.mock('@temporalio/activity', () => ({
  heartbeat: vi.fn(),
}));

// Keep the wall-clock heartbeat wrapper from spinning a real interval.
vi.mock('./heartbeatTicker.js', () => ({
  withWallClockHeartbeat: (_details: unknown, fn: () => Promise<unknown>) => fn(),
}));

// Mock the in-process gate model call. Tests set `mockGateResponse` to the
// raw text the agent would emit; runGate1 (FACT_SEARCH) / gates 2-4 parse it.
let mockGateResponse: string | (() => never) = '{"passed": true, "feedback": "ok", "score": 9}';
const queryCalls: string[] = [];
vi.mock('../services/claudeSdkAgent.js', () => ({
  createClaudeSDKAgent: () => ({
    async *query(prompt: string) {
      queryCalls.push(prompt);
      if (typeof mockGateResponse === 'function') mockGateResponse(); // throw → infra error path
      yield { type: 'assistant', message: { content: [{ type: 'text', text: mockGateResponse }] } };
    },
  }),
}));

// Import after mocks are registered.
const { runGateCascade } = await import('./runGateCascade.js');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    number: '1',
    skill: 'some-skill',
    inputs: [],
    output: 'out.md',
    verify: '',
    run: 'inline',
    notes: '',
    passCondition: '',
    stageType: StageType.DEFAULT,
    dependsOn: [],
    backpropSkill: '',
    // Only gate 1 enabled so we isolate gate-1 dispatch (cascade fail-fast
    // means a gate-1 pass would skip the rest anyway).
    failFast: { maxRetries: 3, gates: [1] },
    permissionMode: 'acceptEdits',
    model: '',
    timeout: 0,
    tneEngine: false,
    tneEngineMaxIterations: 3,
    ...overrides,
  };
}

let dir: string;
function writeOutput(content: string): string {
  const p = join(dir, 'out.md');
  writeFileSync(p, content, 'utf-8');
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate1-'));
  queryCalls.length = 0;
  mockGateResponse = '{"passed": true, "feedback": "ok", "score": 9}';
});

// ─── Gate 1 dispatch by stage type ─────────────────────────────────────────────

describe('Gate 1 — type-specific dispatch', () => {
  it('CREATIVE → auto-pass without calling the model', async () => {
    const p = writeOutput('anything');
    const res = await runGateCascade(makeStep({ stageType: StageType.CREATIVE }), p);
    expect(res.passed).toBe(true);
    expect(res.gateResults[0].gateNumber).toBe(1);
    expect(res.gateResults[0].feedback).toMatch(/Creative content/);
    expect(queryCalls.length).toBe(0); // no LLM call for creative
  });

  it('CODE → passes on non-empty content', async () => {
    const p = writeOutput('def foo():\n    return 1\n');
    const res = await runGateCascade(makeStep({ stageType: StageType.CODE }), p);
    expect(res.passed).toBe(true);
    expect(res.gateResults[0].feedback).toMatch(/Code check passed/);
    expect(queryCalls.length).toBe(0);
  });

  it('CODE → fails on empty/whitespace content', async () => {
    const p = writeOutput('   \n  ');
    const res = await runGateCascade(makeStep({ stageType: StageType.CODE }), p);
    expect(res.passed).toBe(false);
    expect(res.gateResults[0].gateNumber).toBe(1);
    expect(res.gateResults[0].feedback).toMatch(/empty/i);
  });

  it('ANALYSIS → structure check passes on non-empty content', async () => {
    const p = writeOutput('## Heading\n\nsome analysis body');
    const res = await runGateCascade(makeStep({ stageType: StageType.ANALYSIS }), p);
    expect(res.passed).toBe(true);
    expect(res.gateResults[0].feedback).toMatch(/Structure check passed/);
    expect(queryCalls.length).toBe(0);
  });

  it('DEFAULT → structure check fails on empty content', async () => {
    const p = writeOutput('   ');
    const res = await runGateCascade(makeStep({ stageType: StageType.DEFAULT }), p);
    expect(res.passed).toBe(false);
    expect(res.gateResults[0].gateNumber).toBe(1);
    expect(res.gateResults[0].feedback).toMatch(/empty/i);
  });

  it('FACT_SEARCH → routes to the harness gate and parses a passing JSON result', async () => {
    mockGateResponse = '{"passed": true, "feedback": "all claims cited", "score": 8}';
    const p = writeOutput('The sky is blue [1].');
    const res = await runGateCascade(makeStep({ stageType: StageType.FACT_SEARCH }), p);
    expect(res.passed).toBe(true);
    expect(res.gateResults[0].gateNumber).toBe(1);
    expect(queryCalls.length).toBe(1);
    expect(queryCalls[0]).toMatch(/r-cao1-skeptics-and-citations/);
  });

  it('FACT_SEARCH → fails when the harness gate returns passed:false', async () => {
    mockGateResponse = '{"passed": false, "feedback": "uncited claim on line 3"}';
    const p = writeOutput('The sky is green.');
    const res = await runGateCascade(makeStep({ stageType: StageType.FACT_SEARCH }), p);
    expect(res.passed).toBe(false);
    expect(res.gateResults[0].feedback).toMatch(/uncited claim/);
  });

  it('FACT_SEARCH → SDK throw surfaces as an infrastructure error and short-circuits', async () => {
    mockGateResponse = () => { throw new Error('network down'); };
    const p = writeOutput('claim');
    const res = await runGateCascade(
      makeStep({ stageType: StageType.FACT_SEARCH, failFast: { maxRetries: 3, gates: [1, 2] } }),
      p,
    );
    expect(res.passed).toBe(false);
    expect(res.infrastructureError).toBe(true);
    // Gate 2 must NOT run after an infra error on gate 1.
    expect(res.gateResults).toHaveLength(1);
    expect(res.gateResults[0].error).toBe('infrastructure');
  });
});

// ─── Cascade-level behavior (gate 1 as first gate) ─────────────────────────────

describe('Gate 1 — cascade integration', () => {
  it('runs gate 1 FIRST and a gate-1 pass skips remaining gates (fail-fast)', async () => {
    // CREATIVE auto-passes gate 1; gates 2-4 should never invoke the model.
    const p = writeOutput('creative output');
    const res = await runGateCascade(
      makeStep({ stageType: StageType.CREATIVE, failFast: { maxRetries: 3, gates: [1, 2, 3, 4] } }),
      p,
    );
    expect(res.passed).toBe(true);
    expect(res.gateResults).toHaveLength(1);
    expect(res.gateResults[0].gateNumber).toBe(1);
    expect(queryCalls.length).toBe(0);
  });

  it('dry-run short-circuits gate 1 to a pass without reading content', async () => {
    const p = writeOutput(''); // empty would normally fail the structure check
    const res = await runGateCascade(
      makeStep({ stageType: StageType.DEFAULT }),
      p,
      0,
      true, // dryRun
    );
    expect(res.passed).toBe(true);
    expect(res.gateResults[0].feedback).toBe('[DRY RUN]');
    expect(queryCalls.length).toBe(0);
  });

  it('missing output file fails before any gate runs', async () => {
    const res = await runGateCascade(makeStep(), join(dir, 'does-not-exist.md'));
    expect(res.passed).toBe(false);
    expect(res.gateResults[0].gateNumber).toBe(0);
    expect(res.finalFeedback).toMatch(/does not exist/);
  });
});
