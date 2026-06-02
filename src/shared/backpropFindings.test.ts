/**
 * Backprop-to-inputs pure-function tests.
 *
 * Ports the spirit of the Python engine's backprop_inputs test cases:
 *   - `## Backprop to Inputs` section at the end of a file
 *   - section followed by another `## ` heading
 *   - multiple `backprop_to_inputs:` feedback signals
 *   - no findings
 */

import { describe, it, expect } from 'vitest';
import {
  extractSectionFromOutput,
  scanFeedbackForFindings,
  formatFindingsForReview,
} from './backpropFindings.js';
import type { InputFinding } from './types.js';

const TS = '2026-06-02T00:00:00.000Z';

describe('extractSectionFromOutput', () => {
  it('extracts a section at the end of the file', () => {
    const output = [
      '# Report',
      '',
      'Some body text.',
      '',
      '## Backprop to Inputs',
      '',
      'The budget assumption of $50k is too low; use $80k.',
      '',
    ].join('\n');
    expect(extractSectionFromOutput(output)).toBe(
      'The budget assumption of $50k is too low; use $80k.',
    );
  });

  it('stops at the next ## heading', () => {
    const output = [
      '## Backprop to Inputs',
      '',
      'Add the EU market to scope.',
      '',
      '## Next Section',
      '',
      'unrelated content',
      '',
    ].join('\n');
    expect(extractSectionFromOutput(output)).toBe('Add the EU market to scope.');
  });

  it('is case-insensitive on the heading', () => {
    const output = '## backprop TO inputs\n\nlowercase heading still matches\n';
    expect(extractSectionFromOutput(output)).toBe('lowercase heading still matches');
  });

  it('returns null when there is no section', () => {
    expect(extractSectionFromOutput('# Report\n\njust a normal doc\n')).toBeNull();
  });

  it('returns null for an empty section body', () => {
    // Heading at end of file with only whitespace after it → empty capture,
    // no finding. Faithful to Python's `\s*\n(.*?)(?=\n^##\s|\Z)` semantics.
    expect(extractSectionFromOutput('## Backprop to Inputs\n\n')).toBeNull();
  });
});

describe('scanFeedbackForFindings', () => {
  it('captures multiple signals, one finding per match', () => {
    const feedback = [
      'The output is decent but a few things:',
      'backprop_to_inputs: "tighten the persona definition"',
      'Also:',
      "backprop_to_inputs: 'add a competitor table'",
      'backprop_to_inputs: clarify the pricing tiers',
    ].join('\n');
    const findings = scanFeedbackForFindings(feedback, 'evaluator.1', 'e-some-eval', TS);
    expect(findings.map((f) => f.content)).toEqual([
      'tighten the persona definition',
      'add a competitor table',
      'clarify the pricing tiers',
    ]);
    for (const f of findings) {
      expect(f.sourceStep).toBe('evaluator.1');
      expect(f.sourceSkill).toBe('e-some-eval');
      expect(f.status).toBe('pending');
      expect(f.timestamp).toBe(TS);
    }
  });

  it('returns [] when there are no signals', () => {
    expect(scanFeedbackForFindings('no signals here', 'evaluator.1', 'e-x', TS)).toEqual([]);
  });

  it('returns [] for empty feedback', () => {
    expect(scanFeedbackForFindings('', 'evaluator.1', 'e-x', TS)).toEqual([]);
  });
});

describe('formatFindingsForReview', () => {
  it('renders pending findings with count, numbering, and options', () => {
    const findings: InputFinding[] = [
      { sourceStep: 'generator.2', sourceSkill: 'skill-a', content: 'first finding', timestamp: TS, status: 'pending' },
      { sourceStep: 'evaluator.1', sourceSkill: 'skill-b', content: 'second finding', timestamp: TS, status: 'pending' },
      { sourceStep: 'generator.3', sourceSkill: 'skill-c', content: 'applied already', timestamp: TS, status: 'applied' },
    ];
    const doc = formatFindingsForReview(findings);
    expect(doc).toContain('## Backprop to Inputs -- Review Required');
    expect(doc).toContain('2 pending finding(s)');
    expect(doc).toContain('### Finding 1 (from skill-a, step generator.2)');
    expect(doc).toContain('first finding');
    expect(doc).toContain('### Finding 2 (from skill-b, step evaluator.1)');
    expect(doc).toContain('second finding');
    // Only pending findings are rendered.
    expect(doc).not.toContain('applied already');
    // Options list.
    expect(doc).toContain('[A] Apply all');
    expect(doc).toContain('[B] Apply selected');
    expect(doc).toContain('[C] Reject all');
    expect(doc).toContain('[D] Defer');
  });
});
