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
