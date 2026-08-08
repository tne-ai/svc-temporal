import { describe, it, expect } from 'vitest';
import { METADATA_ENCODING_KEY } from '@temporalio/common';
import { GzipPayloadCodec } from './compressionCodec.js';

const te = new TextEncoder();
const td = new TextDecoder();

function jsonPayload(obj: unknown) {
  return {
    metadata: { [METADATA_ENCODING_KEY]: te.encode('json/plain') },
    data: te.encode(JSON.stringify(obj)),
  };
}

describe('GzipPayloadCodec', () => {
  const codec = new GzipPayloadCodec();

  it('round-trips a large payload losslessly and compresses it under the gRPC limit', async () => {
    // ~28 MB of repetitive-but-realistic generated-code-ish JSON.
    const big = { files: Array.from({ length: 4000 }, (_, i) => ({
      path: `src/components/Widget${i}.tsx`,
      content: `import React from 'react';\nexport function Widget${i}(){ return <div className="w-${i}">Widget ${i} ${'x'.repeat(200)}</div>; }\n`.repeat(6),
    })) };
    const original = jsonPayload(big);
    expect(original.data.length).toBeGreaterThan(4 * 1024 * 1024); // exceeds the 4MB gRPC limit

    const [encoded] = await codec.encode([original]);
    expect(td.decode(encoded.metadata![METADATA_ENCODING_KEY])).toBe('binary/gzip');
    expect(encoded.data!.length).toBeLessThan(4 * 1024 * 1024); // now fits under the limit

    const [decoded] = await codec.decode([encoded]);
    expect(td.decode(decoded.metadata![METADATA_ENCODING_KEY])).toBe('json/plain');
    expect(td.decode(decoded.data!)).toBe(td.decode(original.data)); // byte-for-byte
  });

  it('leaves small payloads untouched (readable in the UI)', async () => {
    const small = jsonPayload({ ok: true, n: 42 });
    const [encoded] = await codec.encode([small]);
    expect(td.decode(encoded.metadata![METADATA_ENCODING_KEY])).toBe('json/plain');
    expect(encoded.data).toBe(small.data); // unchanged reference — passthrough
  });

  it('passes through legacy uncompressed payloads on decode', async () => {
    const legacy = jsonPayload({ legacy: true });
    const [decoded] = await codec.decode([legacy]);
    expect(td.decode(decoded.data!)).toBe(td.decode(legacy.data));
  });
});
