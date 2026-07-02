/**
 * Read-only Cypher query against svc-graph, as a first-class Activity.
 *
 * Promotes the logic already living in piAgentTools.ts's `graph_traverse` Pi
 * tool (which only runs when an LLM step chooses to call it) into something
 * a Workflow can call directly via proxyActivities — e.g. a Ralph loop or
 * watchdog step that wants to read the goal/project graph without going
 * through an LLM tool call. piAgentTools.ts's tool is unchanged in behavior;
 * it now just delegates its HTTP call through this same constants pair.
 *
 * Fire-and-forget shape (fail-soft, 3s timeout) matches emitEvent.ts — a
 * graph outage should never hard-fail a workflow step.
 */
import { GRAPH_SERVICE_URL, GRAPH_SECRET } from '../shared/constants.js';

export interface GraphQueryParams {
  fleet: string;
  orgId: string;
  cypher: string;
  params?: Record<string, string>;
}

export interface GraphQueryResult {
  ok: boolean;
  rows: unknown[];
  error?: string;
}

export async function graphQuery(params: GraphQueryParams): Promise<GraphQueryResult> {
  if (!GRAPH_SERVICE_URL) return { ok: false, rows: [], error: 'GRAPH_SERVICE_URL not configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (GRAPH_SECRET) headers['x-graph-secret'] = GRAPH_SECRET;

    const res = await fetch(`${GRAPH_SERVICE_URL}/graph/${params.fleet}/${params.orgId}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cypher: params.cypher, params: params.params || {} }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return { ok: false, rows: [], error: await res.text() };
    const data = (await res.json()) as { rows: unknown[] };
    return { ok: true, rows: data.rows };
  } catch (err: any) {
    return { ok: false, rows: [], error: err?.message || String(err) };
  }
}
