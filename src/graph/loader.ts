/**
 * graph/loader.ts — Load and cache fleet graph.yaml ontology files.
 *
 * Each fleet declares its knowledge graph in config/{fleet}/graph.yaml.
 * That file defines node types, edge types, and named Cypher traversals.
 * We load it once per fleet and cache it for the worker lifetime.
 *
 * CONFIG_DIR env var points to the app-erp config/ directory.
 * Default: assumes svc-temporal runs alongside app-erp with configs at
 * the standard relative path, or ORION_CONFIG_DIR is set explicitly.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// Allow explicit override; fall back to a path relative to the repo root.
const CONFIG_DIR =
  process.env.ORION_CONFIG_DIR ??
  process.env.CONFIG_DIR ??
  path.join(process.cwd(), 'config');

// Module-level cache: fleet → parsed YAML
const _cache = new Map<string, GraphYaml>();

export interface TraversalDef {
  description: string;
  entry_node: string;
  entry_id_param: string;
  pattern: string;
  returns: Array<{ name: string; type: string }>;
  used_by: Array<{ agent: string; intent: string }>;
}

export interface GraphYaml {
  graph: {
    fleet: string;
    nodes: Record<string, { label: string; table: string; id_field: string; properties: string[] }>;
    edges: Record<string, {
      label: string;
      from: string;
      to: string;
      properties: string[];
    }>;
    traversals: Record<string, TraversalDef>;
    event_edge_map: Array<{
      edge: string;
      written_by: { agent: string; intent: string };
      trigger: string;
    }>;
  };
}

/**
 * Load and parse the graph.yaml for a fleet. Result is cached.
 * Throws if the file doesn't exist or is malformed.
 */
export function loadGraphYaml(fleet: string): GraphYaml {
  if (_cache.has(fleet)) return _cache.get(fleet)!;

  const filePath = path.join(CONFIG_DIR, fleet, 'graph.yaml');
  if (!fs.existsSync(filePath)) {
    throw new Error(`graph.yaml not found for fleet '${fleet}' at ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw) as GraphYaml;
  _cache.set(fleet, parsed);
  return parsed;
}

/** Clear the cache (useful in tests). */
export function clearGraphCache(): void {
  _cache.clear();
}
