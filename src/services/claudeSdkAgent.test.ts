import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK's `query` function. The factory is recreated per test.
const mockSdkQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockSdkQuery(...args),
}));

import { createClaudeSDKAgent } from './claudeSdkAgent.js';

beforeEach(() => {
  mockSdkQuery.mockReset();
});

/** Build an async iterable that yields the given events in order. */
function streamOf(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

/** Build an async iterable that yields some events then throws. */
function streamOfThenThrow(events: unknown[], err: Error): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
      throw err;
    },
  };
}

describe('createClaudeSDKAgent — stream loop (regression)', () => {
  it('passes through all events when the stream completes normally', async () => {
    mockSdkQuery.mockReturnValue(streamOf([
      { type: 'message_start' },
      { type: 'content_block_start' },
      { type: 'message_stop' },
    ]));

    const agent = createClaudeSDKAgent();
    const received: unknown[] = [];
    for await (const ev of agent.query('hello')) received.push(ev);

    expect(received).toEqual([
      { type: 'message_start' },
      { type: 'content_block_start' },
      { type: 'message_stop' },
    ]);
  });
});
