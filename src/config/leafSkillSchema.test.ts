import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadLeafSkillSchema } from './leafSkillSchema.js';

let tempRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'leafSchemaTest-'));
  // The loader's findTnePluginsRoot() probes for plugins/tne/skills as a sentinel
  mkdirSync(join(tempRoot, 'plugins', 'tne', 'skills'), { recursive: true });
  prevEnv = process.env.TNE_PLUGINS_PATH;
  process.env.TNE_PLUGINS_PATH = tempRoot;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.TNE_PLUGINS_PATH;
  else process.env.TNE_PLUGINS_PATH = prevEnv;
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeSkill(skillName: string, frontmatter: string, schemas: Record<string, object> = {}) {
  const skillDir = join(tempRoot, 'plugins', 'test-plugin', 'skills', skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${skillName}\n`);
  const schemasDir = join(tempRoot, 'plugins', 'test-plugin', 'skills', 'shared-schemas');
  mkdirSync(schemasDir, { recursive: true });
  for (const [name, schema] of Object.entries(schemas)) {
    writeFileSync(join(schemasDir, `${name}.json`), JSON.stringify(schema));
  }
}

describe('loadLeafSkillSchema — plural output_schemas with mode', () => {
  it('loads the correct schema for the given mode', () => {
    writeSkill(
      'lens-test',
      `name: lens-test\noutput_schemas:\n  evaluate: ../shared-schemas/lensEvaluate.json\n  feedback: ../shared-schemas/lensFeedback.json\n  revise: ../shared-schemas/lensRevise.json`,
      {
        lensEvaluate: { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false },
        lensFeedback: { type: 'object', properties: { peer_label: { type: 'string' } }, required: ['peer_label'], additionalProperties: false },
        lensRevise:   { type: 'object', properties: { revised_score: { type: 'integer' } }, required: ['revised_score'], additionalProperties: false },
      },
    );

    const result = loadLeafSkillSchema('lens-test', 'evaluate');

    expect(result).not.toBeNull();
    expect(result!.schema).toEqual({
      type: 'object',
      properties: { score: { type: 'integer' } },
      required: ['score'],
      additionalProperties: false,
    });
    expect(result!.schemaPath).toContain('lensEvaluate.json');
  });

  it('returns null and warns when plural shape is declared but mode arg is missing', () => {
    writeSkill(
      'lens-test-no-mode',
      `name: lens-test-no-mode\noutput_schemas:\n  evaluate: ../shared-schemas/lensEvaluate.json`,
      { lensEvaluate: { type: 'object', properties: {}, additionalProperties: false } },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = loadLeafSkillSchema('lens-test-no-mode');  // no mode arg

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('plural output_schemas but caller did not pass mode'));
    warnSpy.mockRestore();
  });

  it('returns null and warns when mode is not in the output_schemas map', () => {
    writeSkill(
      'lens-test-bad-mode',
      `name: lens-test-bad-mode\noutput_schemas:\n  evaluate: ../shared-schemas/lensEvaluate.json`,
      { lensEvaluate: { type: 'object', properties: {}, additionalProperties: false } },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = loadLeafSkillSchema('lens-test-bad-mode', 'unknown_mode');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no entry for mode='unknown_mode'"));
    warnSpy.mockRestore();
  });
});

describe('loadLeafSkillSchema — singular output_schema_path (regression)', () => {
  it('loads the schema when only singular is declared (mode arg ignored)', () => {
    writeSkill(
      'leaf-test-singular',
      `name: leaf-test-singular\noutput_schema_path: ../shared-schemas/intakeOutput.json`,
      { intakeOutput: { type: 'object', properties: { company_name: { type: 'string' } }, required: ['company_name'], additionalProperties: false } },
    );

    // mode is irrelevant for singular shape — passing it should not cause an error
    const result = loadLeafSkillSchema('leaf-test-singular', 'evaluate');

    expect(result).not.toBeNull();
    expect(result!.schema).toEqual({
      type: 'object',
      properties: { company_name: { type: 'string' } },
      required: ['company_name'],
      additionalProperties: false,
    });
  });

  it('loads the schema when only singular is declared and no mode arg passed', () => {
    writeSkill(
      'leaf-test-singular-no-mode',
      `name: leaf-test-singular-no-mode\noutput_schema_path: ../shared-schemas/intakeOutput.json`,
      { intakeOutput: { type: 'object', properties: {}, additionalProperties: false } },
    );

    const result = loadLeafSkillSchema('leaf-test-singular-no-mode');

    expect(result).not.toBeNull();
  });
});

describe('loadLeafSkillSchema — both shapes declared (edge case)', () => {
  it('prefers singular and warns when both output_schema_path and output_schemas are present', () => {
    writeSkill(
      'leaf-test-both',
      `name: leaf-test-both\noutput_schema_path: ../shared-schemas/singular.json\noutput_schemas:\n  evaluate: ../shared-schemas/plural-eval.json`,
      {
        singular:      { type: 'object', properties: { from: { const: 'singular' } }, required: ['from'], additionalProperties: false },
        'plural-eval': { type: 'object', properties: { from: { const: 'plural'   } }, required: ['from'], additionalProperties: false },
      },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = loadLeafSkillSchema('leaf-test-both', 'evaluate');

    expect(result).not.toBeNull();
    expect((result!.schema as any).properties.from.const).toBe('singular');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('declares BOTH output_schema_path and output_schemas'));
    warnSpy.mockRestore();
  });
});
