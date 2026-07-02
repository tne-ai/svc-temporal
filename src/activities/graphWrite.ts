/**
 * Write path (upsert-node / write-edge) against svc-graph, as first-class
 * Activities — the write-side counterpart to graphQuery.ts.
 *
 * IMPORTANT — confirmation gating is NOT enforced here. For chat-driven
 * writes, orion's graphAgentTools.ts enforces a same-turn user-confirmation
 * convention (graph_propose_update -> user says yes -> graph_commit_update).
 * For autonomous Workflow-driven writes (no human typing in a chat turn),
 * that convention doesn't apply — a Workflow calling `graphWriteNode`
 * directly is committing immediately, no proposal step.
 *
 * The intended pattern for autonomous writes, not yet built: a Workflow
 * proposes a change, then `condition()`-waits on a Signal (e.g.
 * `approveGraphUpdate`) sent from a UI action before calling this Activity.
 * That needs a UI surface to send the signal from, which doesn't exist yet —
 * documented here so it's easy to pick up. Until that lands, only call these
 * Activities from Workflows where an immediate, unreviewed write is
 * genuinely fine (e.g. the trustbench-style project mirror sync).
 */
import { GRAPH_SERVICE_URL, GRAPH_SECRET } from '../shared/constants.js';

function graphHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (GRAPH_SECRET) headers['x-graph-secret'] = GRAPH_SECRET;
  return headers;
}

export interface GraphWriteNodeParams {
  fleet: string;
  orgId: string;
  nodeType: string;
  nodeId: string;
  props: Record<string, string>;
}

export interface GraphWriteEdgeParams {
  fleet: string;
  orgId: string;
  edgeLabel: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  props?: Record<string, string>;
}

export interface GraphWriteResult {
  ok: boolean;
  error?: string;
}

export async function graphWriteNode(params: GraphWriteNodeParams): Promise<GraphWriteResult> {
  if (!GRAPH_SERVICE_URL) return { ok: false, error: 'GRAPH_SERVICE_URL not configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${GRAPH_SERVICE_URL}/graph/${params.fleet}/${params.orgId}/upsert-node`, {
      method: 'POST',
      headers: graphHeaders(),
      body: JSON.stringify({ node_type: params.nodeType, node_id: params.nodeId, props: params.props }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export async function graphWriteEdge(params: GraphWriteEdgeParams): Promise<GraphWriteResult> {
  if (!GRAPH_SERVICE_URL) return { ok: false, error: 'GRAPH_SERVICE_URL not configured' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${GRAPH_SERVICE_URL}/graph/${params.fleet}/${params.orgId}/write-edge`, {
      method: 'POST',
      headers: graphHeaders(),
      body: JSON.stringify({
        edge_label: params.edgeLabel,
        from_type: params.fromType,
        from_id: params.fromId,
        to_type: params.toType,
        to_id: params.toId,
        props: params.props || {},
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
