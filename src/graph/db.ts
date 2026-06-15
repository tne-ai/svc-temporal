/**
 * graph/db.ts — Per-org Kuzu database connection cache.
 *
 * Kuzu is an embedded graph database (like SQLite). Each org gets its own
 * .kuzu file at ORION_DATA_DIR/graphs/{fleet}/{org_id}.kuzu. Opening a
 * Database object is expensive; we cache one per (fleet, org_id) pair for
 * the lifetime of the worker process.
 *
 * Why Kuzu lives here (svc-temporal) and not in Orion:
 *   Orion's backend image is Alpine/musl. Kuzu ships as a glibc wheel/native
 *   module and cannot run on musl. svc-temporal uses node:20-slim (Debian,
 *   glibc), so kuzu installs natively with no workarounds.
 *
 * Thread safety: Kuzu allows multiple Connection objects from a single
 * Database, but the Database itself must be opened once. We open one
 * Database per (fleet, org_id) and create a fresh Connection for each query.
 * Connections are not shared across concurrent calls.
 */

import kuzu from 'kuzu';
import path from 'path';
import fs from 'fs';
import { ensureSchema } from './bootstrap.js';

const DATA_DIR = process.env.ORION_DATA_DIR ?? path.join(process.env.HOME ?? '/tmp', '.orion', 'data');

// Module-level cache: "(fleet):(org_id)" → kuzu.Database
const _databases = new Map<string, typeof kuzu.Database.prototype>();

/**
 * Return the path to the Kuzu DB file for a given fleet + org.
 * Creates parent directories if they don't exist.
 */
export function dbPath(fleet: string, orgId: string): string {
  const dir = path.join(DATA_DIR, 'graphs', fleet);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${orgId}.kuzu`);
}

/**
 * Return a fresh Kuzu Connection for the given fleet + org.
 * Opens (and caches) the Database on first call; bootstraps schema on first open.
 *
 * Callers should not hold connections across await boundaries — create one,
 * use it, let it go out of scope.
 */
export async function getConnection(fleet: string, orgId: string): Promise<typeof kuzu.Connection.prototype> {
  const key = `${fleet}:${orgId}`;

  if (!_databases.has(key)) {
    const p = dbPath(fleet, orgId);
    const db = new kuzu.Database(p);
    await ensureSchema(fleet, db);
    _databases.set(key, db);
  }

  return new kuzu.Connection(_databases.get(key)!);
}
