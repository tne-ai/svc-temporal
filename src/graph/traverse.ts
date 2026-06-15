/**
 * graph/traverse.ts — Execute named Cypher traversals from graph.yaml.
 *
 * Named traversals are the only public API for querying the graph.
 * No agent or skill ever writes raw Cypher — they call a traversal by slug
 * and get back a structured list of row objects.
 *
 * The traversal's `pattern` field is the full Cypher query with $param
 * placeholders. We bind them from the `params` argument and execute.
 *
 * Return rows are mapped to the names declared in the traversal's `returns`
 * list, so callers get consistent key names regardless of the underlying query.
 */

import { getConnection } from './db.js';
import { loadGraphYaml } from './loader.js';

/**
 * Run a named traversal for a given fleet + org.
 *
 * @param fleet          Fleet slug, e.g. "appfolio" or "regen-ag"
 * @param orgId          Organisation ID — selects the right Kuzu DB file
 * @param traversalSlug  Key from graph.yaml traversals block, e.g. "tenant_compliance_context"
 * @param params         Named parameters matching $placeholders in the Cypher pattern
 * @returns              Array of row objects keyed by the traversal's `returns` names
 */
export async function graphTraverse(
  fleet: string,
  orgId: string,
  traversalSlug: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const yaml = loadGraphYaml(fleet);
  const traversal = yaml.graph.traversals[traversalSlug];
  if (!traversal) {
    throw new Error(`Unknown traversal '${traversalSlug}' for fleet '${fleet}'`);
  }

  const conn = await getConnection(fleet, orgId);
  const result = await conn.query(traversal.pattern, params);

  if (!result || result.length === 0) return [];

  const returnNames = traversal.returns.map((r) => r.name);
  const rows: Record<string, unknown>[] = [];

  // Kuzu returns results as an array of arrays; map each row to named keys.
  for (const row of result) {
    const obj: Record<string, unknown> = {};
    returnNames.forEach((name, i) => {
      obj[name] = serializeValue(row[i]);
    });
    rows.push(obj);
  }

  return rows;
}

/**
 * Serialize Kuzu node/rel objects and other values to plain JSON-safe types.
 * Kuzu wraps graph entities in objects with _label, _id, etc. — we flatten
 * them to their property maps for readability in the LLM context.
 */
function serializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(serializeValue);

  const obj = val as Record<string, unknown>;

  // Kuzu node object shape: { _label: 'Tenant', _id: {...}, prop1: ..., ... }
  if ('_label' in obj && '_id' in obj) {
    const { _label, _id, ...props } = obj;
    return { _type: _label, ...Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, serializeValue(v)])
    )};
  }

  // Plain object — recurse
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, serializeValue(v)])
  );
}
