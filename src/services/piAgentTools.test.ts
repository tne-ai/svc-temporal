import { describe, expect, it, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { buildGitAskPassEnv, checkBashCommandSafety, getGitHubToken } from './piAgentTools.js';

describe('piAgentTools bash safety', () => {
  it('allows https GitHub clone URLs instead of treating //github.com as an absolute path', () => {
    expect(checkBashCommandSafety(
      'git clone https://github.com/tne-ai/compass-crm.git compass-crm',
      '/tmp/workspace',
    )).toEqual({ ok: true });
  });

  it('allows git config URL rewrite keys with colon-slash syntax', () => {
    expect(checkBashCommandSafety(
      'git -c url.https:/.insteadOf=gh:/ clone gh://github.com/tne-ai/compass-crm.git compass-crm',
      '/tmp/workspace',
    )).toEqual({ ok: true });
  });

  it('still blocks real absolute paths outside the workspace', () => {
    const result = checkBashCommandSafety('cat /home/dev/.ssh/id_rsa', '/tmp/workspace');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('escapes workspace');
  });
});

describe('piAgentTools GitHub token env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers GH_TOKEN for child git commands', () => {
    vi.stubEnv('GH_TOKEN', 'gh-test-token');
    vi.stubEnv('GITHUB_TOKEN', 'github-test-token');
    expect(getGitHubToken()).toBe('gh-test-token');
  });

  it('builds non-interactive GIT_ASKPASS env when a token exists', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', 'github-test-token');
    const env = buildGitAskPassEnv();
    expect(env.GITHUB_TOKEN).toBe('github-test-token');
    expect(env.GH_TOKEN).toBe('github-test-token');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBeTruthy();
    await expect(fs.access(env.GIT_ASKPASS!)).resolves.toBeUndefined();
  });

  it('does not configure askpass when no token exists', () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_PAT', '');
    vi.stubEnv('TNE_PLUGINS_GITHUB_TOKEN', '');
    expect(buildGitAskPassEnv()).toEqual({});
  });
});
