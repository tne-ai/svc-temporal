import { describe, it, expect } from 'vitest';
import { answerFromEvents } from './answerFromEvents.js';
import { appendTextBlock } from './appendTextBlock.js';

/**
 * The gap Codex found: `appendTextBlock` was correct and the Claude SDK path
 * ignored it, because `event.result` overwrote the accumulated text. A pure test
 * of the joiner cannot see that — only a test of which string wins can.
 */
describe('answerFromEvents', () => {
  it('prefers the accumulated blocks over the harness summary', () => {
    // This is the whole finding: the SDK's own concatenation has no separator,
    // so taking it discards the one thing the join was for.
    const accumulated = ['…Hispanic, and m', 'litigation'].reduce(appendTextBlock, '');
    const answer = answerFromEvents(accumulated, '…Hispanic, and mlitigation');
    expect(answer.split('\n').pop()).toBe('litigation');
  });

  it('falls back to the harness summary when no blocks were streamed', () => {
    expect(answerFromEvents('', 'the whole answer')).toBe('the whole answer');
  });

  it('treats whitespace-only accumulation as nothing', () => {
    expect(answerFromEvents('   \n  ', 'fallback')).toBe('fallback');
  });

  it('is empty when neither side has anything', () => {
    expect(answerFromEvents('', undefined)).toBe('');
    expect(answerFromEvents('   ', undefined)).toBe('');
  });

  it('keeps the accumulated text verbatim, separators included', () => {
    const accumulated = ['one', 'two'].reduce(appendTextBlock, '');
    expect(answerFromEvents(accumulated, 'ignored')).toBe('one\n\ntwo');
  });
});

describe('applied more than once, as the event loop does', () => {
  it('is idempotent: a second result event cannot displace the first', () => {
    // The Claude SDK path calls this inside the loop, so it can run again if a
    // second `result` arrives. The old code assigned unconditionally, so the
    // LAST summary won; now the first non-empty answer stands.
    let answer = '';
    answer = answerFromEvents(answer, 'first summary');
    answer = answerFromEvents(answer, 'second summary');
    expect(answer).toBe('first summary');
  });

  it('never lets a summary displace accumulated blocks, however many arrive', () => {
    let answer = 'accumulated blocks';
    answer = answerFromEvents(answer, 'summary A');
    answer = answerFromEvents(answer, 'summary B');
    expect(answer).toBe('accumulated blocks');
  });

  it('still takes a summary if the first result carried nothing', () => {
    let answer = '';
    answer = answerFromEvents(answer, undefined);
    answer = answerFromEvents(answer, 'the real summary');
    expect(answer).toBe('the real summary');
  });
});
