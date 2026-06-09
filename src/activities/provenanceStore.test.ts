import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  outputHash,
  shortHash,
  buildProvenanceRecord,
  selectRecordInput,
  provenanceRoot,
  provenanceRoots,
  recordPath,
} from './provenanceStore.js';

const NOW = '2026-06-09T00:00:00Z';

describe('outputHash / shortHash', () => {
  it('matches a known sha256 and 16-char prefix', () => {
    const text = 'hello world';
    const full = createHash('sha256').update(text, 'utf-8').digest('hex');
    expect(outputHash(text)).toBe(full);
    expect(shortHash(text)).toBe(full.slice(0, 16));
    expect(shortHash(text)).toHaveLength(16);
  });

  it('is stable and content-addressed (different content → different key)', () => {
    expect(shortHash('a')).not.toBe(shortHash('b'));
    expect(shortHash('a')).toBe(shortHash('a'));
  });
});

describe('buildProvenanceRecord', () => {
  it('builds a schema-1 record with rounded fidelity + hash', () => {
    const rec = buildProvenanceRecord({
      skill: 'p-foo',
      outputArtifact: 'OUT',
      inputArtifact: 'IN',
      fidelity: 0.953217,
      tier: 'tier0-llm',
      nowIso: NOW,
      repairId: 'tne-ai-repair-x',
    });
    expect(rec).toEqual({
      schema: '1',
      skill: 'p-foo',
      output_hash: outputHash('OUT'),
      input: 'IN',
      fidelity: 0.9532, // rounded to 4 places like the Python writer
      tier: 'tier0-llm',
      recorded_at: NOW,
      repair_id: 'tne-ai-repair-x',
    });
  });

  it('defaults repair_id to null when omitted', () => {
    const rec = buildProvenanceRecord({
      skill: 's',
      outputArtifact: 'o',
      inputArtifact: 'i',
      fidelity: 0.9,
      tier: 'contextual',
      nowIso: NOW,
    });
    expect(rec.repair_id).toBeNull();
  });
});

describe('selectRecordInput (cache hit/miss decision)', () => {
  it('HIT: returns input from a well-formed record', () => {
    const raw = JSON.stringify({ schema: '1', input: 'reconstructed', fidelity: 0.95 });
    expect(selectRecordInput(raw)).toBe('reconstructed');
  });

  it('MISS: null raw (file not found) → null', () => {
    expect(selectRecordInput(null)).toBeNull();
  });

  it('MISS: unparseable JSON → null', () => {
    expect(selectRecordInput('{not json')).toBeNull();
  });

  it('MISS: record present but empty/missing input → null', () => {
    expect(selectRecordInput(JSON.stringify({ schema: '1', input: '' }))).toBeNull();
    expect(selectRecordInput(JSON.stringify({ schema: '1' }))).toBeNull();
  });
});

describe('persistence paths', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    delete process.env.TNE_DATA;
  });
  afterEach(() => {
    process.env = { ...ORIG };
    vi.restoreAllMocks();
  });

  it('uses $TNE_DATA/ktap/provenance when TNE_DATA is set', () => {
    process.env.TNE_DATA = '/data';
    expect(provenanceRoot()).toBe('/data/ktap/provenance');
  });

  it('falls back to ~/.tne/provenance when TNE_DATA is unset', () => {
    const root = provenanceRoot();
    expect(root.endsWith('/.tne/provenance')).toBe(true);
  });

  it('provenanceRoots de-dupes when primary == home fallback', () => {
    // TNE_DATA unset → primary IS the home fallback → single root.
    expect(provenanceRoots()).toHaveLength(1);
  });

  it('provenanceRoots returns both when TNE_DATA differs from home', () => {
    process.env.TNE_DATA = '/data';
    const roots = provenanceRoots();
    expect(roots[0]).toBe('/data/ktap/provenance');
    expect(roots[1].endsWith('/.tne/provenance')).toBe(true);
    expect(roots).toHaveLength(2);
  });

  it('recordPath includes skill dir + short-hash filename', () => {
    expect(recordPath('/root', 'p-foo', 'OUT')).toBe(`/root/p-foo/${shortHash('OUT')}.json`);
  });
});
