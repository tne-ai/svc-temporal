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

  it('prefers the populated body-sop block over a stale frontmatter sop', () => {
    // Mirrors the half-migrated p-ceo1-manage-strategy we hit in S3 on
    // 2026-04-24: the `## SOP` block was populated with the NEW canonical
    // config, but the `sop:` frontmatter still carried a stale one-row
    // preamble from the previous format. The old "first extractor with any
    // phases wins" rule meant a 1-row frontmatter beat a rich but
    // 0-row body-sop stub; flipping to "max phases wins" keeps the body-sop
    // whenever it has more real content.
    const p = writeSkill('p-halfmigrated', `---
name: p-halfmigrated
sop: "/r-coo-sop1-process\\n  SCOPE=p-halfmigrated\\n  MAX_ITERATIONS=50\\n\\n  ## Preamble\\n  | # | Skill | Inputs | Output | Verify | Notes |\\n  |---|-------|--------|--------|--------|-------|\\n  | 1 | stale-skill | — | stale-out.md | — | — |"
---

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-halfmigrated
  MAX_ITERATIONS=1

  ## Preamble
  ${PHASE_TABLE}

  ## Generator
  | # | Skill | Inputs | Output | Verify | Notes |
  |---|-------|--------|--------|--------|-------|
  | 1 | gen-one | — | g1.md | — | — |
  | 2 | gen-two | — | g2.md | — | — |
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-halfmigrated');
    // Body-sop has 3 phase rows (1 preamble + 2 generator); frontmatter has 1.
    // Max-phases rule → body-sop wins.
    expect(cfg.maxIterations).toBe(1);
    expect(cfg.preamble).toHaveLength(1);
    expect(cfg.preamble[0].skill).toBe('step-one');
    expect(cfg.generator).toHaveLength(2);
  });

  it('falls through to frontmatter sop when body-sop is a SCOPE-only stub', () => {
    // Body-sop with no tables at all: frontmatter (if present and populated)
    // is the only source of phase info and must still parse.
    const p = writeSkill('p-bodysop-stub', `---
name: p-bodysop-stub
sop: "/r-coo-sop1-process\\n  SCOPE=p-bodysop-stub\\n\\n  ## Preamble\\n  | # | Skill | Inputs | Output | Verify | Notes |\\n  |---|-------|--------|--------|--------|-------|\\n  | 1 | fm-only-skill | — | out.md | — | — |"
---

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-bodysop-stub
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-bodysop-stub');
    expect(cfg.preamble).toHaveLength(1);
    expect(cfg.preamble[0].skill).toBe('fm-only-skill');
  });

  it('parses structured frontmatter dict sop: (p-debug2-fanout shape)', () => {
    // p-debug2-fanout in tne-plugins declares the SOP entirely in YAML
    // frontmatter (process_type + sop: phases: …) and leaves the body
    // with only a `<!-- config in sop: frontmatter -->` marker. Every
    // string extractor returns null; the dict extractor must succeed.
    const p = writeSkill('p-debug2-fanout', `---
name: p-debug2-fanout
process_type: r-coo-sop91-process
scope: internal
sop:
  max_iterations: 1
  evaluator_mode: sequential-only
  delta_prop: true
  eval_class: content
  phases:
    postamble:
      human_gate: false
      steps:
      - id: debug2-write-color
        skill: debug2-write-color
        description: Theme = warm. Pick three warm colours.
      - id: debug2-write-color-1
        skill: debug2-write-color
        description: Theme = cool. Pick three cool colours.
      - id: debug2-write-color-2
        skill: debug2-write-color
        description: Theme = earthy. Pick three earthy words.
sop_migration: auto
---

# P-DEBUG2. Multi-Step Fanout

## SOP

<!-- config in sop: frontmatter -->
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-debug2-fanout'); // filename fallback
    expect(cfg.maxIterations).toBe(1);
    expect(cfg.evaluatorMode).toBe('sequential-only');
    expect(cfg.approvalGate).toBe(false);
    expect(cfg.postamble).toHaveLength(3);
    expect(cfg.preamble).toHaveLength(0);
    expect(cfg.postamble.map(s => s.skill)).toEqual([
      'debug2-write-color',
      'debug2-write-color',
      'debug2-write-color',
    ]);
    expect(cfg.postamble[0].number).toBe('1');
    expect(cfg.postamble[2].number).toBe('3');
    // No depends_on declared, so the parallel-fanout DAG resolves to a
    // single wave: every step has an empty dependsOn.
    expect(cfg.postamble.every(s => s.dependsOn.length === 0)).toBe(true);
  });

  it('dict sop: maps `depends_on: [step-id]` to sequential dependsOn numbers', () => {
    const p = writeSkill('p-dict-deps', `---
name: p-dict-deps
process_type: r-coo-sop91-process
sop:
  scope: p-dict-deps
  max_iterations: 2
  phases:
    generator:
      steps:
      - id: a
        skill: skill-a
      - id: b
        skill: skill-b
        depends_on: [a]
      - id: c
        skill: skill-c
        depends_on: [a, b]
sop_migration: auto
---

## SOP

<!-- config in sop: frontmatter -->
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-dict-deps');
    expect(cfg.generator).toHaveLength(3);
    expect(cfg.generator[0].dependsOn).toEqual([]);
    expect(cfg.generator[1].dependsOn).toEqual(['1']);
    expect(cfg.generator[2].dependsOn).toEqual(['1', '2']);
  });

  it('dict sop: exempts command + machine-data-output steps from content gates', () => {
    // Regression for the app-foundry blueprint loop: a `run: subagent` step
    // whose output is blueprint.json is data, not prose. The LLM content
    // judges (gates 2-4) read it as an "incomplete document", failed it, and
    // the executeStep retry loop re-invoked p-cpo16 forever. Machine-data
    // outputs (and command steps) must carry NO content gates; a subagent step
    // producing a prose deliverable (.md) keeps the full cascade.
    const p = writeSkill('p-cpo12-shape', `---
name: p-cpo12-shape
process_type: r-coo-sop91-process
sop:
  scope: p-cpo12-shape
  max_iterations: 1
  phases:
    generator:
      steps:
      - id: blueprint-data-model
        skill: p-cpo16-blueprint-data-model
        run: subagent
        output: TNE-CONTEXT/cpo/app-builds/x/blueprint.json
      - id: build
        skill: inline
        run: command
        output: TNE-CONTEXT/cpo/app-builds/x/app-build.json
      - id: write-summary
        skill: some-writer
        run: subagent
        output: TNE-CONTEXT/cpo/app-builds/x/summary.md
sop_migration: auto
---

## SOP

<!-- config in sop: frontmatter -->
`);
    const cfg = parseSkillFile(p);
    expect(cfg.generator).toHaveLength(3);
    // subagent → blueprint.json : machine data, no content gates
    expect(cfg.generator[0].failFast.gates).toEqual([]);
    // command : deterministic, no content gates
    expect(cfg.generator[1].failFast.gates).toEqual([]);
    // subagent → .md prose deliverable : full content cascade
    expect(cfg.generator[2].failFast.gates).toEqual([1, 2, 3, 4]);
  });

  it('dict sop: respects `human_gate: true` on preamble', () => {
    // p-debug1-three-words style — single preamble step with a human gate.
    const p = writeSkill('p-debug1-three-words', `---
name: p-debug1-three-words
process_type: r-coo-sop91-process
sop:
  max_iterations: 1
  evaluator_mode: sequential-only
  delta_prop: true
  phases:
    preamble:
      human_gate: true
      steps:
      - id: debug1-write-words
        skill: debug1-write-words
        description: Worker writes three colour words via the Write tool.
sop_migration: auto
---

## SOP

<!-- config in sop: frontmatter -->
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-debug1-three-words');
    expect(cfg.approvalGate).toBe(true);
    expect(cfg.preamble).toHaveLength(1);
    expect(cfg.preamble[0].skill).toBe('debug1-write-words');
    expect(cfg.preamble[0].notes).toContain('Write tool');
  });

  it('prefers a populated body-sop over a dict frontmatter sop:', () => {
    // Tie-breaker check: if both forms have phases, the body-sop wins
    // because string extractors run before the dict candidate.
    const p = writeSkill('p-mixed', `---
name: p-mixed
process_type: r-coo-sop91-process
sop:
  scope: p-mixed
  phases:
    preamble:
      steps:
      - id: stale-fm
        skill: stale-fm
sop_migration: auto
---

## SOP

\`\`\`
/r-coo-sop1-process
  SCOPE=p-mixed
  MAX_ITERATIONS=1

  ## Preamble
  ${PHASE_TABLE}
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-mixed');
    // Body-sop has 1 row (step-one); dict frontmatter has 1 row too.
    // Tie → string extractor (body-sop) wins by ladder order.
    expect(cfg.preamble).toHaveLength(1);
    expect(cfg.preamble[0].skill).toBe('step-one');
  });

  it('ignores frontmatter sop: dict with no usable phases', () => {
    // A `sop: {}` or `sop: { phases: {} }` mapping must not shadow a real
    // legacy fenced block elsewhere in the file.
    const p = writeSkill('p-empty-dict-sop', `---
name: p-empty-dict-sop
process_type: r-coo-sop91-process
sop:
  max_iterations: 1
  phases: {}
sop_migration: auto
---

## r-coo-sop1-process Config

\`\`\`
/r-coo-sop1-process
  SCOPE=p-empty-dict-sop

  ## Preamble
  ${PHASE_TABLE}
\`\`\`
`);
    const cfg = parseSkillFile(p);
    expect(cfg.scope).toBe('p-empty-dict-sop');
    expect(cfg.preamble).toHaveLength(1);
    expect(cfg.preamble[0].skill).toBe('step-one');
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
