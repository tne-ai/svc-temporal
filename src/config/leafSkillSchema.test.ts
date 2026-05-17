import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
