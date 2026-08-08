/**
 * Gzip PayloadCodec — transparently compresses Temporal payloads that exceed a
 * small threshold, so large activity results / workflow args don't blow past
 * the Temporal server's gRPC max message size (default 4 MB).
 *
 * Why: the App Foundry p-cpo12 generator activity returns a large result
 * (~28 MB of generated app JSON/code). Temporal's frontend rejects it with
 * `ResourceExhausted: grpc: received message larger than max (… vs 4194304)`,
 * so the activity can never complete → Temporal retries it forever and the
 * FSM wave never advances. Generated code/JSON compresses ~8-10×, so gzip
 * brings 28 MB under the 4 MB limit with headroom.
 *
 * This codec MUST be installed symmetrically on every Temporal participant that
 * reads or writes these payloads — both svc-temporal Workers (worker.ts) and
 * every Client that talks to this namespace (svc-temporal client.ts AND the
 * orion-backend Temporal client). A participant without the codec receives
 * gzip bytes it can't decode. The orion side ships an identical implementation.
 *
 * Pattern: canonical Temporal "encoding" codec. encode() replaces a payload's
 * data with gzip(data) and stamps `encoding: binary/gzip`, stashing the
 * original encoding under `z-orig-encoding` so decode() can restore it exactly.
 * Small payloads (< THRESHOLD) pass through untouched (no overhead, still
 * readable in the Temporal UI).
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { METADATA_ENCODING_KEY, type Payload, type PayloadCodec } from '@temporalio/common';

const GZIP_ENCODING = 'binary/gzip';
const ORIG_ENCODING_KEY = 'z-orig-encoding';
/** Only compress payloads larger than this (bytes). Small payloads stay
 *  plaintext so they remain human-readable in the Temporal UI and avoid the
 *  ~20-byte gzip header overhead. */
const COMPRESS_THRESHOLD_BYTES = 8 * 1024;

const te = new TextEncoder();
const td = new TextDecoder();

export class GzipPayloadCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((p) => {
      const data = p.data;
      if (!data || data.length < COMPRESS_THRESHOLD_BYTES) return p;
      const compressed = gzipSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      const metadata: Record<string, Uint8Array> = { ...(p.metadata ?? {}) };
      // Preserve the original encoding so decode() can restore the payload byte-for-byte.
      const origEncoding = p.metadata?.[METADATA_ENCODING_KEY];
      metadata[ORIG_ENCODING_KEY] = origEncoding ?? te.encode('binary/plain');
      metadata[METADATA_ENCODING_KEY] = te.encode(GZIP_ENCODING);
      return { metadata, data: new Uint8Array(compressed) };
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((p) => {
      const enc = p.metadata?.[METADATA_ENCODING_KEY];
      if (!enc || td.decode(enc) !== GZIP_ENCODING || !p.data) return p;
      const decompressed = gunzipSync(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength));
      const metadata: Record<string, Uint8Array> = { ...(p.metadata ?? {}) };
      const orig = metadata[ORIG_ENCODING_KEY];
      delete metadata[ORIG_ENCODING_KEY];
      if (orig) metadata[METADATA_ENCODING_KEY] = orig;
      else delete metadata[METADATA_ENCODING_KEY];
      return { metadata, data: new Uint8Array(decompressed) };
    });
  }
}

/** dataConverter fragment to spread into Worker.create / new Client. */
export const compressionDataConverter = {
  payloadCodecs: [new GzipPayloadCodec()],
};
