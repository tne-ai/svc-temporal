/**
 * graph/server.ts — Lightweight HTTP server exposing graph operations.
 *
 * Runs on GRAPH_SERVER_PORT (default 8001) alongside the Temporal worker.
 * Orion's fsmInvoke.ts registers a `graph_traverse` tool that calls this
 * server when the LLM invokes it during skill execution.
 *
 * Why a separate HTTP server rather than a Temporal activity:
 *   LLM tool calls are synchronous request/response — the LLM calls a tool
 *   and waits for the result before continuing. Temporal activities run inside
 *   a workflow context and can't be invoked on-demand from outside one.
 *   A small HTTP server in the same process solves this cleanly: no new
 *   deployment, no separate service, Kuzu stays in-process (glibc).
 *
 * Auth:
 *   Optional HMAC-SHA256 request signing. Set GRAPH_SERVER_SECRET in both
 *   svc-temporal and Orion envs. Requests without a valid X-Graph-Signature
 *   header are rejected when the secret is configured. Omit the env var to
 *   disable auth (dev mode).
 *
 * Endpoints:
 *   GET  /graph/health
 *   POST /graph/traverse     { fleet, org_id, traversal_slug, params }
 *   POST /graph/upsert-node  { fleet, org_id, node_type, node_id, props }
 *   POST /graph/write-edge   { fleet, org_id, edge_label, from_type, to_type, from_id, to_id, props }
 */

import http from 'http';
import crypto from 'crypto';
import { graphTraverse } from './traverse.js';
import { graphUpsertNode, graphWriteEdge } from './sync.js';

const PORT = parseInt(process.env.GRAPH_SERVER_PORT ?? '8001', 10);
const SECRET = process.env.GRAPH_SERVER_SECRET ?? '';

function verifySignature(body: string, header: string | undefined): boolean {
  if (!SECRET) return true; // auth disabled
  if (!header) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/graph/health') {
    json(res, 200, { status: 'ok', service: 'graph-server' });
    return;
  }

  if (method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  const rawBody = await readBody(req);
  const sig = req.headers['x-graph-signature'] as string | undefined;

  if (!verifySignature(rawBody, sig)) {
    json(res, 401, { error: 'Invalid or missing X-Graph-Signature' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  try {
    if (url === '/graph/traverse') {
      const { fleet, org_id, traversal_slug, params } = body as {
        fleet: string; org_id: string; traversal_slug: string; params: Record<string, string>;
      };
      const rows = await graphTraverse(fleet, org_id, traversal_slug, params ?? {});
      json(res, 200, { rows, traversal_slug, fleet, org_id });

    } else if (url === '/graph/upsert-node') {
      const { fleet, org_id, node_type, node_id, props } = body as {
        fleet: string; org_id: string; node_type: string; node_id: string; props: Record<string, string>;
      };
      await graphUpsertNode(fleet, org_id, node_type, node_id, props ?? {});
      json(res, 200, { ok: true });

    } else if (url === '/graph/write-edge') {
      const { fleet, org_id, edge_label, from_type, to_type, from_id, to_id, props } = body as {
        fleet: string; org_id: string; edge_label: string;
        from_type: string; to_type: string;
        from_id: string; to_id: string; props: Record<string, string>;
      };
      await graphWriteEdge(fleet, org_id, edge_label, from_type, to_type, from_id, to_id, props ?? {});
      json(res, 200, { ok: true });

    } else {
      json(res, 404, { error: `Unknown endpoint: ${url}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: msg });
  }
}

/**
 * Start the graph HTTP server. Called from worker.ts after the Temporal
 * workers are created so the process is already in a stable state.
 */
export function startGraphServer(): void {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[graph-server] Unhandled error:', err);
      if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    });
  });

  server.listen(PORT, () => {
    console.log(`[graph-server] Listening on :${PORT}`);
  });

  server.on('error', (err) => {
    console.error('[graph-server] Server error:', err);
  });
}
