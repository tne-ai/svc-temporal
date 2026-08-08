import { describe, it, expect } from 'vitest';
import { normalizeUsage } from './normalizeUsage.js';

describe('normalizeUsage', () => {
  it('reads the Anthropic spelling, cache counts included', () => {
    expect(
      normalizeUsage({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 3,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 3,
    });
  });

  it('reads the OpenAI spelling, which carries no cache breakdown', () => {
    expect(normalizeUsage({ prompt_tokens: 6, completion_tokens: 1 })).toEqual({
      inputTokens: 6,
      outputTokens: 1,
    });
  });

  it('reads Pi’s spelling — the one the Pi harness actually sends', () => {
    expect(
      normalizeUsage({ input: 6, output: 1, cacheRead: 4, cacheWrite: 2, totalTokens: 7 }),
    ).toEqual({
      inputTokens: 6,
      outputTokens: 1,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 4,
    });
  });

  it('maps Pi cacheWrite to creation and cacheRead to read, not the reverse', () => {
    const norm = normalizeUsage({ input: 0, output: 0, cacheRead: 111, cacheWrite: 222 });
    expect(norm?.cacheCreationInputTokens).toBe(222);
    expect(norm?.cacheReadInputTokens).toBe(111);
  });

  it('prefers the Anthropic spelling when a router passes through two at once', () => {
    expect(
      normalizeUsage({ input_tokens: 50, output_tokens: 5, prompt_tokens: 999, completion_tokens: 999 }),
    ).toMatchObject({ inputTokens: 50, outputTokens: 5 });
  });

  it('keeps a real zero, which is a measurement rather than an absence', () => {
    expect(normalizeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('fills a missing half of a pair with zero rather than dropping the usage', () => {
    expect(normalizeUsage({ output: 12 })).toMatchObject({ inputTokens: 0, outputTokens: 12 });
  });

  it('ignores non-finite counts instead of propagating NaN into the bill', () => {
    expect(normalizeUsage({ input: Number.NaN, output: Number.POSITIVE_INFINITY })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: undefined,
      cacheReadInputTokens: undefined,
    });
  });

  it('returns null for a usage object in none of the three spellings', () => {
    expect(normalizeUsage({ tokens: 10 })).toBeNull();
    expect(normalizeUsage({})).toBeNull();
  });

  it('returns null for null, undefined and non-objects', () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
    expect(normalizeUsage('12')).toBeNull();
    expect(normalizeUsage(12)).toBeNull();
  });

  it('does not read a count that arrived as a numeric string', () => {
    // Trusting one would report tokens the provider never confirmed.
    expect(normalizeUsage({ input: '6', output: '1' })).toBeNull();
  });
});
