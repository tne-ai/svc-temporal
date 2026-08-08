import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { warnOnce, resetWarnedOnce, postStatusKey, postFailureKey, emitEvent, emitJobEvent } from './emitEvent.js';

/**
 * This file had no tests, which is how four silent drops survived long enough to
 * cost a day of diagnosis. The claim the PR makes is "it says so once" — so what
 * is worth pinning is that it says it, and that it says it once.
 */
describe('warnOnce', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWarnedOnce();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    resetWarnedOnce();
  });

  it('says it the first time', () => {
    warnOnce('k', 'the wire is not connected');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('the wire is not connected');
  });

  it('says it once, however many times it happens', () => {
    for (let i = 0; i < 500; i++) warnOnce('k', 'same reason');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says each distinct reason separately', () => {
    warnOnce('a', 'no runId');
    warnOnce('b', 'no URL');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('passes a detail through, and an empty string when there is none', () => {
    warnOnce('a', 'failed', 'ECONNREFUSED');
    warnOnce('b', 'failed');
    expect(warn.mock.calls[0][1]).toBe('ECONNREFUSED');
    expect(warn.mock.calls[1][1]).toBe('');
  });

  it('prefixes every line, so a grep finds all of them', () => {
    warnOnce('a', 'something');
    expect(warn.mock.calls[0][0]).toMatch(/^\[emitEvent\] /);
  });
});

describe('postStatusKey', () => {
  it('separates one status from another', () => {
    // A run of 500s followed by a 401 is a different problem with a different
    // fix. A key of just "status" would report the first and swallow the second.
    expect(postStatusKey('job', 500)).not.toBe(postStatusKey('job', 401));
  });

  it('separates the two streams at the same status', () => {
    expect(postStatusKey('fsm', 401)).not.toBe(postStatusKey('job', 401));
  });

  it('is stable for the same input', () => {
    expect(postStatusKey('job', 401)).toBe(postStatusKey('job', 401));
  });
});

describe('a missing identifier is reported, not swallowed', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetWarnedOnce();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    resetWarnedOnce();
  });

  it('says so when emitEvent has no runId', async () => {
    await emitEvent(undefined, 'message', { text: 'x' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no runId/);
  });

  it('says so when emitJobEvent has no jobId', async () => {
    await emitJobEvent(undefined, 'token_update', { inputTokens: 100 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no jobId/);
  });

  it('does not throw — an activity must never fail on emission', async () => {
    await expect(emitEvent(undefined, 'message')).resolves.toBeUndefined();
    await expect(emitJobEvent(undefined, 'message')).resolves.toBeUndefined();
  });

  it('reports the FSM and job streams as separate reasons', async () => {
    await emitEvent(undefined, 'message');
    await emitJobEvent(undefined, 'message');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('postFailureKey', () => {
  it('separates one cause from another', () => {
    // An hour of ECONNREFUSED followed by timeouts is a different problem.
    const refused = postFailureKey('job', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    const timeout = postFailureKey('job', Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    expect(refused).not.toBe(timeout);
  });

  it('falls back to the error name when there is no code', () => {
    const aborted = postFailureKey('job', Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(aborted).toContain('AbortError');
  });

  it('does not key on the message, which varies per event', () => {
    // A key that varies per event is a memory leak wearing a diagnostic's clothes.
    const a = postFailureKey('job', new Error('connect to 10.0.0.1:53312 failed'));
    const b = postFailureKey('job', new Error('connect to 10.0.0.1:53313 failed'));
    expect(a).toBe(b);
  });

  it('survives a thrown non-object', () => {
    expect(postFailureKey('fsm', 'a string')).toBe('fsm-post-unknown');
    expect(postFailureKey('fsm', null)).toBe('fsm-post-unknown');
    expect(postFailureKey('fsm', undefined)).toBe('fsm-post-unknown');
  });

  it('separates the two streams for the same cause', () => {
    const err = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(postFailureKey('fsm', err)).not.toBe(postFailureKey('job', err));
  });
});

describe('warnOnce cannot fail the activity that called it', () => {
  it('swallows a console that throws', () => {
    // Two callers are outside the outer try, so a throw here would reject.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    resetWarnedOnce();
    expect(() => warnOnce('k', 'message')).not.toThrow();
    warn.mockRestore();
    resetWarnedOnce();
  });

  it('still records the key, so a broken console does not turn into a loop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    resetWarnedOnce();
    warnOnce('k', 'message');
    warn.mockRestore();
    const ok = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnce('k', 'message');
    expect(ok).not.toHaveBeenCalled();
    ok.mockRestore();
    resetWarnedOnce();
  });
});

/**
 * The two paths that need a configured URL. The URL is derived from env at
 * module load, so the module is imported fresh with the env in place — which is
 * also the only way to exercise the unset-URL branch honestly.
 */
describe('a POST that does not arrive says so', () => {
  const load = async (env: Record<string, string>) => {
    vi.resetModules();
    Object.entries(env).forEach(([k, v]) => vi.stubEnv(k, v));
    return import('./emitEvent.js');
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('warns when the fetch rejects', async () => {
    const mod = await load({ HORIZON_API_BASE_URL: 'http://127.0.0.1:9/api/fsm-invoke' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', () => Promise.reject(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })));

    await mod.emitJobEvent('job-1', 'token_update', { inputTokens: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/failed/);
    warn.mockRestore();
  });

  it('warns when the response is not ok, and names the status', async () => {
    const mod = await load({ HORIZON_API_BASE_URL: 'http://127.0.0.1:9/api/fsm-invoke' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 401 }));

    await mod.emitJobEvent('job-1', 'token_update', { inputTokens: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/401/);
    warn.mockRestore();
  });

  it('says nothing when the POST is accepted', async () => {
    const mod = await load({ HORIZON_API_BASE_URL: 'http://127.0.0.1:9/api/fsm-invoke' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, status: 200 }));

    await mod.emitJobEvent('job-1', 'token_update', { inputTokens: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when no URL is configured at all', async () => {
    const mod = await load({ HORIZON_API_BASE_URL: '', FSM_INVOKE_URL: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mod.emitJobEvent('job-1', 'token_update', { inputTokens: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no tokens and no cost/);
    warn.mockRestore();
  });
});
