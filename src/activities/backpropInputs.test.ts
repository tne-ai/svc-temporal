import { describe, it, expect } from 'vitest';
import {
  parseBackpropSection,
  parseFeedbackSignals,
  scanOutputContentForFindings,
  formatFindingsForReview,
  applyFindingsToContent,
  markFindings,
  type InputFinding,
} from './backpropInputs.js';

const NOW = '2026-06-09T00:00:00.000Z';

describe('parseBackpropSection', () => {
  it('extracts the section body up to the next heading', () => {
    const md = [
      '# Output',
      'some text',
      '## Backprop to Inputs',
      '- the market sizing is off',
      '- add a competitor',
      '',
      '## Next Section',
      'ignored',
    ].join('\n');
    expect(parseBackpropSection(md)).toBe('- the market sizing is off\n- add a competitor');
  });

  it('extracts to EOF when no following heading', () => {
    const md = '## Backprop to Inputs\nfinding to end';
    expect(parseBackpropSection(md)).toBe('finding to end');
  });

  it('is case-insensitive on the heading', () => {
    expect(parseBackpropSection('## backprop TO inputs\nx')).toBe('x');
  });

  it('returns null when absent or empty', () => {
    expect(parseBackpropSection('# nope')).toBeNull();
    expect(parseBackpropSection('## Backprop to Inputs\n\n## Next')).toBeNull();
  });
});

describe('parseFeedbackSignals', () => {
  it('parses quoted and bare backprop_to_inputs signals', () => {
    const fb = [
      'backprop_to_inputs: "revise the TAM assumption"',
      'noise',
      "backprop_to_inputs: add a risk section",
    ].join('\n');
    expect(parseFeedbackSignals(fb)).toEqual(['revise the TAM assumption', 'add a risk section']);
  });

  it('returns [] when none', () => {
    expect(parseFeedbackSignals('just feedback')).toEqual([]);
  });
});

describe('scanOutputContentForFindings', () => {
  it('produces a pending finding with provenance', () => {
    const found = scanOutputContentForFindings('## Backprop to Inputs\nfix X', 'generator.2', 'p-foo', NOW);
    expect(found).toEqual([
      { sourceStep: 'generator.2', sourceSkill: 'p-foo', content: 'fix X', timestamp: NOW, status: 'pending' },
    ]);
  });
  it('empty when no section', () => {
    expect(scanOutputContentForFindings('nothing', 's', 'k', NOW)).toEqual([]);
  });
});

describe('formatFindingsForReview', () => {
  it('lists pending findings with options', () => {
    const out = formatFindingsForReview([
      { sourceStep: '1', sourceSkill: 'p-a', content: 'finding one', timestamp: NOW, status: 'pending' },
    ]);
    expect(out).toContain('## Backprop to Inputs -- Review Required');
    expect(out).toContain('**1 finding(s)**');
    expect(out).toContain('### Finding 1 (from p-a, step 1)');
    expect(out).toContain('finding one');
    expect(out).toContain('[A] Apply all');
  });
  it('handles no pending', () => {
    expect(formatFindingsForReview([])).toBe('No pending findings to review.');
  });
});

describe('applyFindingsToContent', () => {
  const approved: InputFinding[] = [
    { sourceStep: '2', sourceSkill: 'p-eval', content: 'bump the SAM', timestamp: NOW, status: 'approved' },
  ];
  const STAMP = '2026-06-09 00:00:00 UTC';

  it('returns null when nothing approved', () => {
    expect(applyFindingsToContent('# in', [{ ...approved[0], status: 'pending' }], STAMP)).toBeNull();
  });

  it('creates a Pipeline Feedback section when none exists', () => {
    const out = applyFindingsToContent('# Inputs\n\nbody', approved, STAMP)!;
    expect(out).toContain('## Pipeline Feedback');
    expect(out).toContain('### Pipeline Feedback -- 2026-06-09 00:00:00 UTC');
    expect(out).toContain('**From p-eval (step 2):**');
    expect(out).toContain('bump the SAM');
    expect(out.indexOf('## Pipeline Feedback')).toBeGreaterThan(out.indexOf('body'));
  });

  it('inserts into an existing Pipeline Feedback section before the next heading', () => {
    const content = ['# Inputs', '', '## Pipeline Feedback', 'old entry', '', '## Other', 'tail'].join('\n');
    const out = applyFindingsToContent(content, approved, STAMP)!;
    // new entry lands inside Pipeline Feedback, before "## Other"
    expect(out.indexOf('bump the SAM')).toBeGreaterThan(out.indexOf('## Pipeline Feedback'));
    expect(out.indexOf('bump the SAM')).toBeLessThan(out.indexOf('## Other'));
    expect(out.indexOf('## Other')).toBeLessThan(out.indexOf('tail'));
  });
});

describe('markFindings', () => {
  it('marks all pending when no indices', () => {
    const fs: InputFinding[] = [
      { sourceStep: '1', sourceSkill: 'a', content: 'x', timestamp: NOW, status: 'pending' },
      { sourceStep: '2', sourceSkill: 'b', content: 'y', timestamp: NOW, status: 'applied' },
    ];
    markFindings(fs, 'approved');
    expect(fs.map((f) => f.status)).toEqual(['approved', 'applied']);
  });

  it('marks selected pending by index within the pending subset', () => {
    const fs: InputFinding[] = [
      { sourceStep: '1', sourceSkill: 'a', content: 'x', timestamp: NOW, status: 'pending' },
      { sourceStep: '2', sourceSkill: 'b', content: 'y', timestamp: NOW, status: 'pending' },
    ];
    markFindings(fs, 'rejected', [1]);
    expect(fs.map((f) => f.status)).toEqual(['pending', 'rejected']);
  });
});
