import { describe, it, expect } from 'vitest';
import { sumAssistantUsage } from './piAgentAdapter.js';

const assistant = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'x' }],
  usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output },
});

describe('sumAssistantUsage', () => {
  it('totals across every assistant message of the run', () => {
    expect(sumAssistantUsage([assistant(100, 10), assistant(50, 5)])).toEqual({
      input: 150,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('totals the cache counts too', () => {
    expect(sumAssistantUsage([assistant(1, 1, 20, 30), assistant(1, 1, 2, 3)])).toEqual({
      input: 2,
      output: 2,
      cacheRead: 22,
      cacheWrite: 33,
    });
  });

  it('counts only assistant messages — a tool result is not an API call', () => {
    const toolResult = { role: 'toolResult', usage: { input: 9999, output: 9999 } };
    const user = { role: 'user', content: 'hi' };
    expect(sumAssistantUsage([user, assistant(7, 3), toolResult])).toMatchObject({
      input: 7,
      output: 3,
    });
  });

  it('returns null when nothing carried usage, so cost stays unmeasured', () => {
    // Distinct from a run that really used zero: null must not price as free.
    expect(sumAssistantUsage([{ role: 'assistant', content: [] }])).toBeNull();
    expect(sumAssistantUsage([])).toBeNull();
  });

  it('returns a zero total when usage was present and really was zero', () => {
    expect(sumAssistantUsage([assistant(0, 0)])).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('returns null when messages is not an array', () => {
    expect(sumAssistantUsage(undefined)).toBeNull();
    expect(sumAssistantUsage(null)).toBeNull();
    expect(sumAssistantUsage({ 0: assistant(1, 1) })).toBeNull();
  });

  it('skips a message whose usage is missing but keeps its siblings', () => {
    const partial = { role: 'assistant', content: [], usage: undefined };
    expect(sumAssistantUsage([partial, assistant(4, 2)])).toMatchObject({ input: 4, output: 2 });
  });

  it('treats a missing or non-numeric field as zero rather than NaN', () => {
    const odd = { role: 'assistant', usage: { input: 5, output: 'lots', cacheRead: null } };
    expect(sumAssistantUsage([odd])).toEqual({
      input: 5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('survives a null entry in the message list', () => {
    expect(sumAssistantUsage([null, assistant(3, 1), undefined])).toMatchObject({ input: 3 });
  });
});
