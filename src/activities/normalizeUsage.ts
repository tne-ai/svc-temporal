/**
 * Canonical token payload orion's jobService.applyTokenUpdate /
 * fsmService.applyTokenUpdate expect.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Pull token counts out of a usage object regardless of which of the three
 * spellings it arrives in: Anthropic (`input_tokens`), Pi
 * (`@mariozechner/pi-ai` `Usage` — `input`), and OpenAI-compatible providers
 * (`prompt_tokens`, via OpenRouter, DeepSeek, Kimi, …).
 *
 * Returns null when it carries none of them — the caller skips the emit rather
 * than reporting a run as having used zero tokens.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  // Anthropic first — when a router passes through more than one shape, this
  // is the one that carries cache information.
  if (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number') {
    return {
      inputTokens: numberOrZero(u.input_tokens),
      outputTokens: numberOrZero(u.output_tokens),
      cacheCreationInputTokens: optionalNumber(u.cache_creation_input_tokens),
      cacheReadInputTokens: optionalNumber(u.cache_read_input_tokens),
    };
  }
  // Pi's shape, as summed by sumAssistantUsage. Also carries cache counts, so
  // it precedes the OpenAI spelling; the three key sets are disjoint, so the
  // ordering cannot mis-pick between them.
  if (typeof u.input === 'number' || typeof u.output === 'number') {
    return {
      inputTokens: numberOrZero(u.input),
      outputTokens: numberOrZero(u.output),
      cacheCreationInputTokens: optionalNumber(u.cacheWrite),
      cacheReadInputTokens: optionalNumber(u.cacheRead),
    };
  }
  if (typeof u.prompt_tokens === 'number' || typeof u.completion_tokens === 'number') {
    return {
      inputTokens: numberOrZero(u.prompt_tokens),
      outputTokens: numberOrZero(u.completion_tokens),
    };
  }
  return null;
}

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
