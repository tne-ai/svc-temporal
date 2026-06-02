/**
 * Backprop-to-inputs file-I/O tests (scanOutputForFindings, applyFindingsToInputs).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanOutputForFindings, applyFindingsToInputs } from './backpropInputs.js';
import type { InputFinding } from '../shared/types.js';

const TS = '2026-06-02T12:00:00.000Z';

let tmpRoot: string;
beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'backprop-')); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

function approved(content: string, step = 'generator.1', skill = 'skill-x'): InputFinding {
  return { sourceStep: step, sourceSkill: skill, content, timestamp: TS, status: 'approved' };
}

describe('scanOutputForFindings', () => {
  it('returns a pending finding for a section', () => {
    const path = join(tmpRoot, 'out.md');
    writeFileSync(path, '# Out\n\n## Backprop to Inputs\n\nuse $80k budget\n');
    const findings = scanOutputForFindings(path, 'generator.2', 'skill-a', TS);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      sourceStep: 'generator.2',
      sourceSkill: 'skill-a',
      content: 'use $80k budget',
      status: 'pending',
    });
  });

  it('returns [] when the file has no section', () => {
    const path = join(tmpRoot, 'plain.md');
    writeFileSync(path, '# Out\n\nnothing to backprop\n');
    expect(scanOutputForFindings(path, 'generator.2', 'skill-a', TS)).toEqual([]);
  });

  it('returns [] when the file does not exist', () => {
    expect(scanOutputForFindings(join(tmpRoot, 'missing.md'), 'g.1', 's', TS)).toEqual([]);
  });
});

describe('applyFindingsToInputs', () => {
  it('appends a fresh ## Pipeline Feedback section when none exists', async () => {
    const path = join(tmpRoot, 'inputs.md');
    writeFileSync(path, '# Inputs\n\n## Scope\n\nbuild a thing\n');
    const ok = await applyFindingsToInputs({
      workspacePath: tmpRoot,
      inputsRelPath: 'inputs.md',
      findings: [approved('widen scope to EU')],
    });
    expect(ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('## Pipeline Feedback');
    expect(text).toContain('### Pipeline Feedback -- ' + TS);
    expect(text).toContain('**From skill-x (step generator.1):**');
    expect(text).toContain('widen scope to EU');
    // The original content is preserved.
    expect(text).toContain('build a thing');
  });

  it('inserts before the next ## heading when a Pipeline Feedback section exists', async () => {
    const path = join(tmpRoot, 'inputs.md');
    writeFileSync(
      path,
      '# Inputs\n\n## Pipeline Feedback\n\n### Pipeline Feedback -- old\n\nold note\n\n## Scope\n\nbuild a thing\n',
    );
    const ok = await applyFindingsToInputs({
      workspacePath: tmpRoot,
      inputsRelPath: 'inputs.md',
      findings: [approved('new note here')],
    });
    expect(ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    // New block lands inside the existing section, before ## Scope.
    const newIdx = text.indexOf('new note here');
    const scopeIdx = text.indexOf('## Scope');
    const oldIdx = text.indexOf('old note');
    expect(newIdx).toBeGreaterThan(oldIdx);
    expect(newIdx).toBeLessThan(scopeIdx);
  });

  it('appends within the section when Pipeline Feedback is the last heading', async () => {
    const path = join(tmpRoot, 'inputs.md');
    writeFileSync(path, '# Inputs\n\n## Pipeline Feedback\n\n### Pipeline Feedback -- old\n\nold note\n');
    const ok = await applyFindingsToInputs({
      workspacePath: tmpRoot,
      inputsRelPath: 'inputs.md',
      findings: [approved('trailing note')],
    });
    expect(ok).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('old note');
    expect(text).toContain('trailing note');
    expect(text.indexOf('trailing note')).toBeGreaterThan(text.indexOf('old note'));
  });

  it('only writes approved findings', async () => {
    const path = join(tmpRoot, 'inputs.md');
    writeFileSync(path, '# Inputs\n');
    const ok = await applyFindingsToInputs({
      workspacePath: tmpRoot,
      inputsRelPath: 'inputs.md',
      findings: [
        { sourceStep: 'g.1', sourceSkill: 's', content: 'pending one', timestamp: TS, status: 'pending' },
      ],
    });
    expect(ok).toBe(false);
    expect(readFileSync(path, 'utf8')).not.toContain('pending one');
  });

  it('returns false when inputsRelPath is empty', async () => {
    const ok = await applyFindingsToInputs({
      workspacePath: tmpRoot,
      inputsRelPath: '',
      findings: [approved('x')],
    });
    expect(ok).toBe(false);
  });
});
