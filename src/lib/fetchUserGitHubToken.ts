/**
 * Worker-side helper to fetch the current user's GitHub OAuth/App token from
 * Orion's authenticated internal endpoint.
 *
 * This gives durable Temporal jobs the same per-user GitHub identity that the
 * in-process Orion agent gets from the UI GitHub sync flow. The token is used
 * only for the current activity/job environment (GH_TOKEN/GITHUB_TOKEN) and is
 * never written to disk by svc-temporal.
 */

import { HORIZON_FSM_BASE, FSM_INVOKE_SECRET } from '../shared/constants.js';

export async function fetchUserGitHubToken(userId: string): Promise<string | null> {
  if (!HORIZON_FSM_BASE || !FSM_INVOKE_SECRET) return null;

  const url = `${HORIZON_FSM_BASE}/github-token/${encodeURIComponent(userId)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-fsm-secret': FSM_INVOKE_SECRET },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn('[fetchUserGitHubToken] non-200 response', { userId, status: res.status });
      return null;
    }
    const data = await res.json() as { token?: string };
    return data.token || null;
  } catch (err: any) {
    console.warn('[fetchUserGitHubToken] request failed', { userId, error: err?.message || String(err) });
    return null;
  }
}
