/**
 * graph/sync.ts — Write nodes and edges into the Kuzu graph.
 *
 * Called from p-skill postambles after a Postgres write completes.
 * The graph is a traversal index — Postgres is the source of truth.
 * These writes keep the graph in sync after state-changing operations.
 *
 * Both functions use MERGE semantics (upsert) so they are idempotent
 * and safe to call on retry.
 */

import { getConnection } from './db.js'; // uses @ladybugdb/core under the hood
import { loadGraphYaml } from './loader.js';

/**
 * Upsert a node into the graph. Safe to call multiple times with the same id.
 *
 * @param fleet     Fleet slug
 * @param orgId     Organisation ID
 * @param nodeType  Node label from graph.yaml, e.g. "Tenant"
 * @param nodeId    The entity's primary key value
 * @param props     Additional property key/value pairs (all stored as strings)
 */
export async function graphUpsertNode(
  fleet: string,
  orgId: string,
  nodeType: string,
  nodeId: string,
  props: Record<string, string> = {},
): Promise<void> {
  const conn = await getConnection(fleet, orgId);

  // Verify the node type exists in the ontology
  const yaml = loadGraphYaml(fleet);
  const nodeDef = Object.values(yaml.graph.nodes).find((n) => n.label === nodeType);
  if (!nodeDef) {
    throw new Error(`Unknown node type '${nodeType}' for fleet '${fleet}'`);
  }

  // Build MERGE ... ON MATCH SET ... ON CREATE SET ...
  const allProps = { id: nodeId, ...props };
  const setClauses = Object.keys(allProps)
    .map((k) => `n.${k} = $${k}`)
    .join(', ');

  // LadybugDB: use prepare() + execute() for parameterized writes
  const cypher = `MERGE (n:${nodeType} {id: $id}) ON MATCH SET ${setClauses} ON CREATE SET ${setClauses}`;
  const ps = await conn.prepare(cypher);
  await conn.execute(ps, allProps);
}

/**
 * Write a directed edge between two existing nodes. Safe to call on retry.
 *
 * Both from and to nodes must already exist in the graph (call graphUpsertNode first).
 *
 * @param fleet      Fleet slug
 * @param orgId      Organisation ID
 * @param edgeLabel  REL TABLE name from graph.yaml, e.g. "CERT_FOR"
 * @param fromType   Label of the source node, e.g. "IncomeCert"
 * @param toType     Label of the target node, e.g. "Tenant"
 * @param fromId     Primary key of the source node
 * @param toId       Primary key of the target node
 * @param props      Optional edge properties (e.g. since_date)
 */
export async function graphWriteEdge(
  fleet: string,
  orgId: string,
  edgeLabel: string,
  fromType: string,
  toType: string,
  fromId: string,
  toId: string,
  props: Record<string, string> = {},
): Promise<void> {
  const conn = await getConnection(fleet, orgId);

  const setClause = Object.keys(props).length
    ? ' SET ' + Object.keys(props).map((k) => `r.${k} = $${k}`).join(', ')
    : '';

  const cypher =
    `MATCH (a:${fromType} {id: $fromId}), (b:${toType} {id: $toId}) ` +
    `MERGE (a)-[r:${edgeLabel}]->(b)${setClause}`;

  const ps = await conn.prepare(cypher);
  await conn.execute(ps, { fromId, toId, ...props });
}
