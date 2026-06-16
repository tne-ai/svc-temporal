// Standalone graph server launcher — no Temporal worker needed
// Usage: node scripts/run-graph-server.mjs
import { startGraphServer } from '../dist/graph/server.js';
startGraphServer();
console.log('[graph-server] Press Ctrl+C to stop');
