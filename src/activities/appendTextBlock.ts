/**
 * Joining the assistant's text blocks into one answer.
 *
 * `stdout += block.text` glued them. A model that writes a sentence, calls a
 * tool mid-thought, and then answers produces two blocks — and the benchmark saw
 *
 *   "…Asian American, Hispanic, and m" + "litigation"
 *   → "…Asian American, Hispanic, and mlitigation"
 *
 * which is one line, so every scorer that reads the last line read that instead
 * of the answer. The task scored 0 with the right answer in the row.
 */

/** Blocks are separated by a blank line, the way paragraphs already are. */
const BLOCK_SEPARATOR = '\n\n';

/**
 * Append a text block to what has been collected so far.
 *
 * Adds a separator only when there is something to separate and the boundary is
 * not already whitespace — so a model that ends its own block with a newline is
 * not given a third one, and the first block is not preceded by blank lines.
 */
export function appendTextBlock(collected: string, block: string): string {
  if (!block) return collected;
  if (!collected) return block;
  const boundaryIsBlank = /\s$/.test(collected) || /^\s/.test(block);
  return boundaryIsBlank ? collected + block : collected + BLOCK_SEPARATOR + block;
}
