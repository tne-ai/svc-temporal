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

describe('createClaudeSDKAgent — stream-catch (Option A persist-fail handling)', () => {
  it('swallows SDK throws after structured_output when error matches persist-fail pattern', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSdkQuery.mockReturnValue(streamOfThenThrow(
      [
        { type: 'message_start' },
        { type: 'result', structured_output: { score: 4 } },  // captured
      ],
      new Error('persist-failed: messageText is not valid JSON (constrained-decode may have failed)'),
    ));

    const agent = createClaudeSDKAgent();
    const received: unknown[] = [];
    // Should NOT throw — error is swallowed because structured_output was captured
    for await (const ev of agent.query('hello')) received.push(ev);

    expect(received).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('swallowed post-emit SDK error'));
    warnSpy.mockRestore();
  });

  it('re-throws when error occurs BEFORE structured_output (even if message matches pattern)', async () => {
    mockSdkQuery.mockReturnValue(streamOfThenThrow(
      [{ type: 'message_start' }],  // no structured_output yet
      new Error('persist-failed: messageText is not valid JSON'),
    ));

    const agent = createClaudeSDKAgent();
    await expect(async () => {
      for await (const _ev of agent.query('hello')) { /* drain */ }
    }).rejects.toThrow(/persist-failed/);
  });

  it('re-throws when error matches no persist-fail pattern (even after structured_output)', async () => {
    mockSdkQuery.mockReturnValue(streamOfThenThrow(
      [{ type: 'result', structured_output: { score: 3 } }],
      new Error('Network error: ECONNRESET'),
    ));

    const agent = createClaudeSDKAgent();
    await expect(async () => {
      for await (const _ev of agent.query('hello')) { /* drain */ }
    }).rejects.toThrow(/ECONNRESET/);
  });
});
