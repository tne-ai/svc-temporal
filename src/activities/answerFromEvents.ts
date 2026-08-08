/**
 * Which text a harness run answers with.
 *
 * Extracted because the two paths disagreed and no test could see it: both
 * accumulate assistant text blocks through `appendTextBlock`, but the Claude SDK
 * path then overwrote the result with the SDK's own `result` string — so the
 * separator that keeps two blocks off one line applied to nothing there.
 *
 * The rule both paths now follow: what was accumulated wins; the harness's own
 * summary is a fallback for adapters that stream no assistant blocks at all.
 */
export function answerFromEvents(accumulated: string, harnessResult: string | undefined): string {
  return accumulated.trim() ? accumulated : (harnessResult ?? '');
}
