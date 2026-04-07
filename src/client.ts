/**
 * Temporal client factory.
 *
 * Creates and caches a Temporal client connection for use by external services
 * (Horizon backend) to start workflows, send signals, and run queries.
 */

import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from './shared/constants.js';

let cachedClient: Client | null = null;

/**
 * Get or create a Temporal client.
 *
 * Lazy initialization: only connects when first called.
 * Reuses the same connection across calls.
 */
export async function getTemporalClient(): Promise<Client> {
  if (cachedClient) return cachedClient;

  const connection = await Connection.connect({
    address: TEMPORAL_ADDRESS,
  });

  cachedClient = new Client({
    connection,
    namespace: TEMPORAL_NAMESPACE,
  });

  return cachedClient;
}

/**
 * Close the cached client connection.
 */
export async function closeTemporalClient(): Promise<void> {
  if (cachedClient) {
    await cachedClient.connection.close();
    cachedClient = null;
  }
}
