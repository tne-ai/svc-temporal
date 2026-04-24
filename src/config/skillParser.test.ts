/**
 * Parser format-compatibility tests.
 *
 * tne-plugins skills exist in three SOP formats in the wild. Every format
 * below should parse to the same (or at least non-zero) phase count.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseSkillFile } from './skillParser.js';

let tmpRoot: string;

beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'skillparser-')); });
afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

function writeSkill(name: string, body: string): string {
  const dir = join(tmpRoot, name);
  require('fs').mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, body);
  return path;
}

const PHASE_TABLE = `| # | Skill | Inputs | Output | Verify | Notes |
|---|-------|--------|--------|--------|-------|
| 1 | step-one | — | out.md | — | — |`;

describe('parseSkillFile — format compatibility', () => {
  it('parses new format: ## SOP body block with fenced content', () => {
    const p = writeSkill('p-new', `---
name: p-new
---

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-new
  MAX_ITERATIONS=1

  ## Preamble
  ${PHASE_TABLE}
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-new');
    expect(cfg.preamble).toHaveLength(1);
  });

  it('parses legacy-fenced format: ## r-coo-sop1-process Config with fenced content', () => {
    const p = writeSkill('p-legacy-fenced', `---
name: p-legacy-fenced
---

## r-coo-sop1-process Config

\`\`\`
/r-coo-sop1-process
  SCOPE=p-legacy-fenced

  ## Postamble
  ${PHASE_TABLE}
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-legacy-fenced');
    expect(cfg.postamble).toHaveLength(1);
  });

  it('parses legacy-inline format: bare /r-coo-sop1-process with sibling ## Preamble', () => {
    // Mirrors p-cfo1: ## SOP stub at bottom, real content inline above.
    const p = writeSkill('p-legacy-inline', `---
name: p-legacy-inline
---

## r-coo-sop1-process Config

/r-coo-sop1-process
SCOPE=p-legacy-inline
MAX_ITERATIONS=3

## Preamble

${PHASE_TABLE}

## Execution

Some prose after the config.

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-legacy-inline
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-legacy-inline');
    expect(cfg.maxIterations).toBe(3);
    expect(cfg.preamble).toHaveLength(1);
  });

  it('falls through horizontal-rule separators inside the legacy-inline block', () => {
    // Mirrors p-cmo8: `---` used as visual separator between config and phase
    // sections. Must not terminate block collection.
    const p = writeSkill('p-hrule', `---
name: p-hrule
---

## r-coo-sop1-process Config

/r-coo-sop1-process
SCOPE=p-hrule

---

## Preamble

${PHASE_TABLE}

---

## Execution
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-hrule');
    expect(cfg.preamble).toHaveLength(1);
  });

  it('ignores /r-coo-sop1-process blocks nested inside a ### subsection', () => {
    // Mirrors p-ceo1-manage-strategy: a documentary code block under
    // `### Phase 1: Strategy` → `#### r-coo-sop1-process Config` describes
    // the sub-pipeline p-CSO1 runs internally. It is NOT the orchestrator's
    // own SOP and must not be picked up as the top-level config.
    const p = writeSkill('p-ceo1-like', `---
name: p-ceo1-like
---

### Phase 1: Strategy

#### r-coo-sop1-process Config

\`\`\`
/r-coo-sop1-process
  SCOPE=p-ceo1-like
  MAX_ITERATIONS=50

  ## Preamble
  ${PHASE_TABLE}
\`\`\`

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-ceo1-like
  MAX_ITERATIONS=1

  ## Postamble
  ${PHASE_TABLE}
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-ceo1-like');
    // The top-level ## SOP block wins; the nested block contributed a preamble
    // but must be ignored, so we see only the postamble from ## SOP.
    expect(cfg.maxIterations).toBe(1);
    expect(cfg.preamble).toHaveLength(0);
    expect(cfg.postamble).toHaveLength(1);
  });

  it('accepts `| Phase |` column header and non-numeric step IDs like "0a"', () => {
    const p = writeSkill('p-phase-col', `---
name: p-phase-col
---

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-phase-col
  MAX_ITERATIONS=1

  ## Preamble
  | Phase | Name | Orchestrator | Run | Dependencies | Notes |
  |-------|------|--------------|-----|--------------|-------|
  | 0a | skill-zero-a | (inline) | inline | (none) | first |
  | 0b | skill-zero-b | (inline) | inline | 0a | second |
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-phase-col');
    expect(cfg.preamble).toHaveLength(2);
    expect(cfg.preamble[0].number).toBe('0a');
    expect(cfg.preamble[0].skill).toBe('skill-zero-a');
    expect(cfg.preamble[1].number).toBe('0b');
    expect(cfg.preamble[1].dependsOn).toEqual(['0a']);
  });

  it('handles stub ## SOP + inline phase sections outside any fence', () => {
    // Mirrors p-ceo2: /r-coo-sop1-process inside a short fenced block,
    // then phase sections as siblings OUTSIDE the fence.
    const p = writeSkill('p-ceo2-like', `---
name: p-ceo2-like
---

## r-coo-sop1-process Config

\`\`\`
/r-coo-sop1-process
  SCOPE=p-ceo2-like
  MAX_ITERATIONS=2
\`\`\`

## Preamble

${PHASE_TABLE}

## Outputs

After.

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-ceo2-like
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-ceo2-like');
    expect(cfg.preamble).toHaveLength(1);
  });
});
