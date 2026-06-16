/**
 * graph/bootstrap.ts — Idempotently create Kuzu node and rel tables from graph.yaml.
 *
 * Called once per (fleet, org_id) when a Database is first opened.
 * All properties are stored as STRING in Kuzu — we don't try to map YAML
 * types to Kuzu types because the graph is a traversal index, not a typed
 * schema. The source of truth for types is Postgres.
 *
 * Kuzu raises an error if you CREATE a table that already exists (even with
 * IF NOT EXISTS in older versions). We catch and ignore those errors so this
 * function is safe to call on an already-bootstrapped database.
 */

import kuzu from '@ladybugdb/core';
import { loadGraphYaml } from './loader.js';

/**
 * Ensure all node and rel tables declared in graph.yaml exist in the Kuzu DB.
 * Safe to call multiple times — existing tables are left unchanged.
 */
export async function ensureSchema(fleet: string, db: typeof kuzu.Database.prototype): Promise<void> {
  let graph: ReturnType<typeof loadGraphYaml>;
  try {
    graph = loadGraphYaml(fleet);
  } catch {
    // Fleet has no graph.yaml — nothing to bootstrap. Non-ERP fleets skip silently.
    return;
  }

  const conn = new kuzu.Connection(db);
  const { nodes, edges } = graph.graph;

  // Create node tables
  for (const [, nodeDef] of Object.entries(nodes)) {
    const label = nodeDef.label;
    const propCols = (nodeDef.properties ?? [])
      .filter((p) => p !== nodeDef.id_field)
      .map((p) => `${p} STRING`)
      .join(', ');
    const cols = propCols ? `id STRING, ${propCols}, PRIMARY KEY(id)` : `id STRING, PRIMARY KEY(id)`;
    try {
      await conn.query(`CREATE NODE TABLE ${label} (${cols})`);
    } catch {
      // Table already exists — ignore.
    }
  }

  // Create rel tables
  for (const [, edgeDef] of Object.entries(edges)) {
    const { label, from: fromKey, to: toKey, properties } = edgeDef;
    const fromLabel = nodes[fromKey]?.label ?? fromKey;
    const toLabel = nodes[toKey]?.label ?? toKey;
    const propCols = (properties ?? []).map((p) => `${p} STRING`).join(', ');
    const extra = propCols ? `, ${propCols}` : '';
    try {
      await conn.query(`CREATE REL TABLE ${label} (FROM ${fromLabel} TO ${toLabel}${extra})`);
    } catch {
      // Table already exists — ignore.
    }
  }
}
