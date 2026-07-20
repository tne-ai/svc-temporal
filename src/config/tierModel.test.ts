import { describe, it, expect } from 'vitest';
import { resolveTierModel, isTierKey } from './tierModel.js';

describe('resolveTierModel', () => {
  it('maps the three tier keys to concrete model ids (mirrors orion skillModelMap)', () => {
    expect(resolveTierModel('opus')).toBe('claude-opus-4-8');
    expect(resolveTierModel('glm-5.2')).toBe('glm-5.2');
    expect(resolveTierModel('kimi-k2.6')).toBe('kimi-k2.6');
  });

  it('passes through concrete ids, aliases, and OpenRouter slugs unchanged', () => {
    expect(resolveTierModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(resolveTierModel('sonnet')).toBe('sonnet');
    expect(resolveTierModel('z-ai/glm-4.6')).toBe('z-ai/glm-4.6');
  });

  it('trims and tolerates empty/undefined', () => {
    expect(resolveTierModel('  opus  ')).toBe('claude-opus-4-8');
    expect(resolveTierModel('')).toBe('');
    expect(resolveTierModel(undefined)).toBe('');
  });

  it('isTierKey recognises exactly the three keys', () => {
    expect(isTierKey('opus')).toBe(true);
    expect(isTierKey('glm-5.2')).toBe(true);
    expect(isTierKey('kimi-k2.6')).toBe(true);
    expect(isTierKey('sonnet')).toBe(false);
    expect(isTierKey('claude-opus-4-8')).toBe(false);
  });
});
