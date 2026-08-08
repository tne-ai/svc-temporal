import { describe, it, expect } from 'vitest';
import { FSM_INVOKE_SECRET, HORIZON_DEV_SHARED_SECRET } from './constants.js';

/**
 * The bug this pins is a disagreement between two repositories, which no
 * typechecker can see: orion's fsmInvoke route falls back to
 * 'fsm-internal-horizon-dev', and this side used to fall back to ''. The client
 * sent nothing, the server expected something, and every job event was answered
 * 401 and discarded without a word.
 *
 * So the assertion is on the literal. If orion's default changes, this stays
 * green and the wire breaks again — which is the honest limit of a test that can
 * only see one side, and the reason the value has a name and a comment saying
 * where its counterpart lives.
 */
describe('the shared secret', () => {
  it('is never empty, whatever the environment does or does not set', () => {
    // '' was the whole bug: falsy, so it never even reached a comparison.
    expect(FSM_INVOKE_SECRET).not.toBe('');
    expect(FSM_INVOKE_SECRET.length).toBeGreaterThan(0);
  });

  it('names the same string orion falls back to', () => {
    // backend/src/routes/fsmInvoke.ts:
    //   const FSM_INVOKE_SECRET = process.env.FSM_INVOKE_SECRET || 'fsm-internal-horizon-dev';
    expect(HORIZON_DEV_SHARED_SECRET).toBe('fsm-internal-horizon-dev');
  });

  it('prefers the environment when one is set', () => {
    // The default exists for local development; production sets both sides and
    // this value is never used.
    const resolved = process.env.FSM_INVOKE_SECRET || HORIZON_DEV_SHARED_SECRET;
    expect(FSM_INVOKE_SECRET).toBe(resolved);
  });

  it('is a plain non-whitespace token, so a header carries it unchanged', () => {
    expect(HORIZON_DEV_SHARED_SECRET).toMatch(/^[\w-]+$/);
  });
});
