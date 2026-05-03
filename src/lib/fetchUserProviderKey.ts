/**
 * Worker-side helper to fetch a user's BYOK upstream-LLM API key from
 * orion's authenticated internal endpoint.
 *
 * SOC2 considerations
 * ───────────────────
 * Workers do NOT have direct DB access and do NOT carry the
 * TOKEN_ENCRYPTION_KEY. Plaintext keys exist on the worker only for
 * the lifetime of a single activity invocation. The worker:
 *   - Sends the FSM_INVOKE_SECRET shared with orion as the bearer of
 *     authority.
 *   - Receives the plaintext over HTTPS (orion handles encryption at
 *     rest in the user_provider_keys table).
 *   - Uses the key for the agent invocation, never persists it.
 *   - Treats 404 as "no BYOK key configured" — workers fall back to
 *     deployment-wide env vars in that case (existing behavior).
 *
 * Failure modes (network, non-200) all return null so a transient
 * orion outage doesn't fail the activity outright — env-var fallback
 * applies, which is safer than refusing to run the step.
 */

import { HORIZON_FSM_BASE, FSM_INVOKE_SECRET } from '../shared/constants.js';

/**
 * Fetch the user's saved API key for an upstream LLM provider.
 * Returns null when no key is configured or the lookup fails.
 *
 * The caller is responsible for falling back to env-var keys when this
 * returns null.
 */
export async function fetchUserProviderKey(
  userId: string,
  provider: 'anthropic' | 'anthropic_oauth' | 'openai' | 'gemini' | 'openrouter',
): Promise<string | null> {
  if (!HORIZON_FSM_BASE || !FSM_INVOKE_SECRET) {
    // No backend wiring — workers running standalone (test envs etc.).
    return null;
  }

  const url = `${HORIZON_FSM_BASE}/byok-keys/${encodeURIComponent(userId)}/${encodeURIComponent(provider)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-fsm-secret': FSM_INVOKE_SECRET },
    });
    if (res.status === 404) return null; // no key configured — fall back to env
    if (!res.ok) {
      console.warn('[fetchUserProviderKey] non-200 response', {
        userId, provider, status: res.status,
      });
      return null;
    }
    const data = await res.json() as { key?: string };
    return data.key || null;
  } catch (err: any) {
    console.warn('[fetchUserProviderKey] request failed', {
      userId, provider, error: err?.message || String(err),
    });
    return null;
  }
}
