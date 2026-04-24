/**
 * buildPrompt regression tests — the user-supplied PROMPT must always reach
 * the agent. For weeks it was being silently dropped because buildPrompt
 * only substituted templateVars into step.notes/step.output, and no
 * tne-plugins skill references {{PROMPT}} in those columns.
 */

import { describe, it, expect } from 'vitest';
import { buildPrompt } from './invokeSkill.js';
import { StageType, type Step } from '../shared/types.js';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    number: '1',
    skill: 'cso14-research-existing-documents',
    inputs: [],
    output: 'cso/out.md',
    verify: '',
    run: 'inline',
    notes: 'Existing docs review',
    passCondition: '',
    stageType: StageType.DEFAULT,
    dependsOn: [],
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('injects templateVars.PROMPT as Task Context', () => {
    const p = buildPrompt(
      makeStep(),
      1,
      { PROMPT: 'Write a business plan for EBP Global' },
    );
    expect(p).toMatch(/## Task Context/);
    expect(p).toContain('Write a business plan for EBP Global');
  });

  it('surfaces non-PROMPT variables under Run Variables', () => {
    const p = buildPrompt(
      makeStep(),
      1,
      { PROMPT: 'Task', ORG: 'EBP Global', TOPIC: 'AI navigation' },
    );
    expect(p).toMatch(/## Run Variables/);
    expect(p).toContain('**ORG**: EBP Global');
    expect(p).toContain('**TOPIC**: AI navigation');
    expect(p).not.toMatch(/\*\*PROMPT\*\*:/); // PROMPT is only in Task Context
  });

  it('embeds inline manifestContent under Available Inputs', () => {
    const p = buildPrompt(
      makeStep(),
      1,
      {},
      undefined,
      undefined,
      undefined,
      '| # | File | Source |\n|---|------|--------|\n| 1 | `cso/a.md` | cso14 |',
    );
    expect(p).toMatch(/## Available Inputs/);
    expect(p).toContain('cso/a.md');
  });

  it('omits optional sections when their inputs are empty', () => {
    const p = buildPrompt(makeStep({ notes: '' }), 1, {});
    expect(p).not.toMatch(/## Task Context/);
    expect(p).not.toMatch(/## Run Variables/);
    expect(p).not.toMatch(/## Available Inputs/);
    expect(p).not.toMatch(/## Feedback from Previous Evaluation/);
  });

  it('still renders the skill invocation line and output target', () => {
    const p = buildPrompt(
      makeStep({ output: '{{OUTPUT_DIR}}/cso2-summary.md' }),
      1,
      { OUTPUT_DIR: 'cso', PROMPT: 'EBP research' },
    );
    expect(p).toContain('Execute /cso14-research-existing-documents');
    expect(p).toContain('Write output to: cso/cso2-summary.md');
  });

  it('includes feedback and human notes when present', () => {
    const p = buildPrompt(
      makeStep(),
      2,
      { PROMPT: 'task' },
      'Previous iteration had issues with X',
      'Please address Y',
    );
    expect(p).toMatch(/\[Iteration 2/);
    expect(p).toMatch(/## Feedback from Previous Evaluation/);
    expect(p).toContain('Previous iteration had issues with X');
    expect(p).toMatch(/## Human Review Notes/);
    expect(p).toContain('Please address Y');
  });
});
