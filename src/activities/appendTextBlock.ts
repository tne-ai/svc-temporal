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
 * The boundary has to be a NEWLINE, not merely whitespace. A first attempt at
 * this treated any trailing space as "already separated", and the next run
 * produced
 *
 *   "New York City is indisputably the home of Banking & " + "litigation"
 *   → "…the home of Banking & litigation"
 *
 * — one line again, scored again against the wrong text. A space does not end a
 * line, and the line is what every scorer reads.
 *
 * A block that already ends with a newline is not given a second one, so a model
 * that formats its own paragraphs keeps its formatting.
 */
export function appendTextBlock(collected: string, block: string): string {
  if (!block) return collected;
  if (!collected) return block;
  const alreadyOnItsOwnLine = collected.endsWith('\n') || block.startsWith('\n');
  return alreadyOnItsOwnLine ? collected + block : collected + BLOCK_SEPARATOR + block;
}
