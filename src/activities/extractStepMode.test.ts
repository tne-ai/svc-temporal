import { describe, it, expect } from 'vitest';
import { extractStepMode } from './invokeSkill.js';

describe('extractStepMode', () => {
  it('extracts mode from step.inputs when present as token', () => {
    expect(extractStepMode({ inputs: ['mode=evaluate', 'company=Aspire'] })).toBe('evaluate');
  });

  it('extracts mode from step.notes when Notes carries mode=<value>', () => {
    expect(extractStepMode({ notes: 'mode=evaluate' })).toBe('evaluate');
    expect(extractStepMode({ notes: 'mode=feedback; peer_packages={{PEERS}}' })).toBe('feedback');
    expect(extractStepMode({ notes: 'mode=pass_1, room' })).toBe('pass_1');
    expect(extractStepMode({ notes: 'mode=pass_2, room' })).toBe('pass_2');
    expect(extractStepMode({ notes: 'something else; mode=revise' })).toBe('revise');
  });

  it('prefers Inputs over Notes when both have mode', () => {
    expect(extractStepMode({ inputs: ['mode=evaluate'], notes: 'mode=feedback' })).toBe('evaluate');
  });

  it('returns undefined when neither Inputs nor Notes has mode', () => {
    expect(extractStepMode({ inputs: ['company=Aspire'], notes: 'some unrelated note' })).toBeUndefined();
    expect(extractStepMode({})).toBeUndefined();
    expect(extractStepMode({ inputs: [], notes: '' })).toBeUndefined();
  });

  it('does NOT match unresolved template-var syntax (PR B SOP cleanup will fix)', () => {
    // p-jpm-retry-lens currently has `mode={{MODE}}` in Notes — character class
    // [A-Za-z0-9_]+ doesn't match braces, so this returns undefined. Documenting
    // the limitation here so the PR B fix has a behavior baseline.
    expect(extractStepMode({ notes: 'mode={{MODE}}' })).toBeUndefined();
    expect(extractStepMode({ inputs: ['mode={{MODE}}'] })).toBe('{{MODE}}');  // inputs path is split-based, captures literal
  });

  it('does NOT match mode= inside a longer identifier (boundary check)', () => {
    // e.g. "subjectmode=evaluate" must NOT match; only word-boundary preceded.
    expect(extractStepMode({ notes: 'subjectmode=evaluate' })).toBeUndefined();
  });
});
