/**
 * Tier-key → concrete model id.
 *
 * Mirrors orion/backend/src/config/skillModelMap.ts `modelForKey`, so a SKILL.md
 * step can declare a coarse *tier* ('opus' / 'glm-5.2' / 'kimi-k2.6') and the FSM
 * engine routes that one step to the same model id orion's per-skill router would
 * pick — the ids LiteLLM actually accepts (glm-5.2 resolves at the proxy; opus =
 * anthropic claude-opus-4-8).
 *
 * This is the engine-side half of per-step model routing (see
 * fsmProcess.workflow.ts `buildStepParams`). A step's declared model may be a
 * template var (`{{HIGH_MODEL}}`) that resolves to a tier key at runtime; once
 * resolved we map the tier key here to a concrete model id before handing it to
 * `resolveModelId` / the invocation backends.
 *
 * BACKWARD COMPATIBLE: anything that isn't one of the three known tier keys is
 * passed through unchanged — a concrete model id, an Anthropic alias
 * (`sonnet`, `opus-4-7`), or an OpenRouter slug all reach `resolveModelId`
 * exactly as before. Env-overridable so an operator can pin the exact ids in
 * their LiteLLM model_list without a code change (same env var names orion uses).
 */

export type TierKey = 'opus' | 'glm-5.2' | 'kimi-k2.6';

/** True when `key` is one of the three routing-table tier keys. */
export function isTierKey(key: string): key is TierKey {
  return key === 'opus' || key === 'glm-5.2' || key === 'kimi-k2.6';
}

/**
 * Map a tier key (or pass-through model id) to the concrete model id the
 * invocation backends should use. Unknown values return unchanged.
 */
export function resolveTierModel(key: string | undefined): string {
  const k = (key || '').trim();
  switch (k) {
    case 'opus':
      // orion pins opus → anthropic claude-opus-4-8 (skillModelMap.modelForKey).
      return process.env.SKILL_MODEL_OPUS_MODEL || 'claude-opus-4-8';
    case 'glm-5.2':
      // Bare model name; routes through LiteLLM (verified to resolve at the proxy).
      return process.env.SKILL_MODEL_GLM_MODEL || 'glm-5.2';
    case 'kimi-k2.6':
      return process.env.SKILL_MODEL_KIMI_MODEL || 'kimi-k2.6';
    default:
      return k;
  }
}
