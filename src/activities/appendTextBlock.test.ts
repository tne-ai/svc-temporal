import { describe, it, expect } from 'vitest';
import { appendTextBlock } from './appendTextBlock.js';

/**
 * The shape that produced a 0 with the right answer in the row: a model wrote a
 * sentence, called a tool mid-thought, then answered. Two text blocks, glued.
 */
describe('appendTextBlock', () => {
  it('does not weld two blocks into one word', () => {
    const glued = appendTextBlock('Asian American, Hispanic, and m', 'litigation');
    expect(glued).not.toContain('mlitigation');
  });

  it('leaves the answer alone on the last line, which is what the scorer reads', () => {
    const joined = appendTextBlock('…research text ending mid-thought, and m', 'litigation');
    expect(joined.split('\n').pop()).toBe('litigation');
  });

  it('returns the first block unchanged, with nothing in front of it', () => {
    expect(appendTextBlock('', 'first')).toBe('first');
  });

  it('ignores an empty block rather than adding a separator for nothing', () => {
    expect(appendTextBlock('kept', '')).toBe('kept');
  });

  it('separates two ordinary blocks by a blank line', () => {
    expect(appendTextBlock('one', 'two')).toBe('one\n\ntwo');
  });

  it('does not add a third newline when the block already ends with one', () => {
    expect(appendTextBlock('one\n', 'two')).toBe('one\ntwo');
    expect(appendTextBlock('one\n\n', 'two')).toBe('one\n\ntwo');
  });

  it('does not add one when the next block starts with a newline', () => {
    expect(appendTextBlock('one', '\ntwo')).toBe('one\ntwo');
  });

  it('still separates when the boundary is only a space', () => {
    // A space does not end a line, and the line is what the scorer reads. The
    // first version of this treated a trailing space as already separated, and
    // the next run produced "…the home of Banking & litigation".
    expect(appendTextBlock('the home of Banking & ', 'litigation')).toBe('the home of Banking & \n\nlitigation');
  });

  it('puts the answer on its own line even after a trailing space', () => {
    expect(appendTextBlock('…Banking & ', 'litigation').split('\n').pop()).toBe('litigation');
  });

  it('still separates after a tab, for the same reason', () => {
    expect(appendTextBlock('x\t', 'y')).toBe('x\t\n\ny');
  });

  it('keeps the blocks in the order they arrived', () => {
    const all = ['a', 'b', 'c'].reduce(appendTextBlock, '');
    expect(all).toBe('a\n\nb\n\nc');
  });

  it('preserves the text inside a block, including its own newlines', () => {
    expect(appendTextBlock('head', 'line one\nline two')).toBe('head\n\nline one\nline two');
  });

  it('is empty for no blocks at all', () => {
    expect(['', '', ''].reduce(appendTextBlock, '')).toBe('');
  });
});
