import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import { buildGitAskPassEnv, buildPiTools, checkBashCommandSafety, getGitHubToken } from './piAgentTools.js';

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

  it('falls back to the deployed GitHub PAT secret key', () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_PAT', '');
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'github-personal-access-token');
    expect(getGitHubToken()).toBe('github-personal-access-token');
  });

  it('builds non-interactive GIT_ASKPASS and gh CLI env when a token exists', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', 'github-pat-test-token');
    const env = buildGitAskPassEnv();
    expect(env.GITHUB_TOKEN).toBe('github-pat-test-token');
    expect(env.GH_TOKEN).toBe('github-pat-test-token');
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('github-pat-test-token');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBeTruthy();
    await expect(fs.access(env.GIT_ASKPASS!)).resolves.toBeUndefined();
  });

  it('can build askpass from a per-job user GitHub token env override', () => {
    const env = buildGitAskPassEnv({ GITHUB_TOKEN: 'user-synced-token' } as any);
    expect(env.GITHUB_TOKEN).toBe('user-synced-token');
    expect(env.GH_TOKEN).toBe('user-synced-token');
  });

  it('does not configure askpass when no token exists', () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GITHUB_PAT', '');
    vi.stubEnv('GITHUB_PERSONAL_ACCESS_TOKEN', '');
    vi.stubEnv('TNE_PLUGINS_GITHUB_TOKEN', '');
    expect(buildGitAskPassEnv()).toEqual({});
  });
});

describe('piAgentTools graph_query', () => {
  const tools = buildPiTools('/tmp/workspace');
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs raw cypher straight to graph-svc, no config file involved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"rows":[{"m":{"id":"1"}}]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await byName('graph_query').execute('call-1', {
      fleet: 'regen-ag', org_id: 'org-carnation',
      cypher: 'MATCH (m:Member) RETURN m LIMIT 1', params: {},
    } as any, new AbortController().signal);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://graph-svc:8002/graph/regen-ag/org-carnation/query');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ cypher: 'MATCH (m:Member) RETURN m LIMIT 1', params: {} });
    expect(result.details).toEqual({ count: 1 });
    expect((result.content[0] as { text: string }).text).toContain('"id": "1"');
  });

  it('surfaces a non-2xx as an error, not a throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad cypher', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await byName('graph_query').execute('call-2', {
      fleet: 'regen-ag', org_id: 'org-carnation', cypher: 'NOT VALID', params: {},
    } as any, new AbortController().signal);

    expect(result.details).toEqual({ count: 0 });
    expect((result.content[0] as { text: string }).text).toContain('bad cypher');
  });
});

describe('piAgentTools app-erp tools', () => {
  // ERP_BASE_URL/ERP_API_KEY (shared/constants.ts) are read once at module
  // import time, same as GRAPH_SERVICE_URL/GRAPH_SECRET — stubEnv in a
  // beforeEach here would have no effect on the already-evaluated constant,
  // so these tests assert against the real default ('http://app-erp:8000',
  // no key) rather than pretending to override it.
  const tools = buildPiTools('/tmp/workspace');
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('erp_get_entities builds the right URL/headers and returns the body on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[{"member_id":"1"}]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await byName('erp_get_entities').execute('call-1', {
      entity: 'member', filters: { current_status: 'active' }, limit: 10,
    } as any, new AbortController().signal);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('http://app-erp:8000/api/entities/member?');
    expect(String(url)).toContain('limit=10');
    expect(String(url)).toContain(encodeURIComponent(JSON.stringify({ current_status: 'active' })));
    expect((opts.headers as Record<string, string>)['Authorization']).toBeUndefined(); // no ERP_API_KEY in test env
    expect(result.details).toEqual({ ok: true, status: 200 });
    expect((result.content[0] as { text: string }).text).toContain('member_id');
  });

  it('erp_create_entity POSTs source/source_ref/fields and surfaces a non-2xx as an error, not a throw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"source is required"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await byName('erp_create_entity').execute('call-2', {
      entity: 'member', fields: { full_name: 'Test' }, source: 'rga-member',
    } as any, new AbortController().signal);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://app-erp:8000/api/entities/member');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ source: 'rga-member', source_ref: undefined, fields: { full_name: 'Test' } });
    expect(result.details).toEqual({ ok: false, status: 400 });
    expect((result.content[0] as { text: string }).text).toContain('source is required');
  });

  it('erp_get_schema hits /api/db/schema/{table} when a table is given, /api/db/schema otherwise', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    await byName('erp_get_schema').execute('call-3', { table: 'rga_members' } as any, new AbortController().signal);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://app-erp:8000/api/db/schema/rga_members');

    await byName('erp_get_schema').execute('call-4', {} as any, new AbortController().signal);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://app-erp:8000/api/db/schema');
  });
});
