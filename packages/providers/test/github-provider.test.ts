import { describe, expect, it } from 'vitest';
import { GitHubProvider, PullRequestChangedError, UnsafeRepositoryPathError } from '../src/github/github-provider.js';
import { ProviderHttpError } from '../src/http.js';

type Route = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;

function stubFetch(routes: Route[]): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(`${init.method ?? 'GET'} ${url}`);
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) {
        const status = hit.status ?? 200;
        return new Response(hit.body === undefined ? '' : JSON.stringify(hit.body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const commitBody = {
  sha: 'b2c3d4',
  commit: {
    message: 'Handle optional discount code in checkout',
    author: { name: 'Dana', email: 'dana@example.com', date: '2026-09-13T14:31:00Z' },
  },
  parents: [{ sha: 'a1b2c3' }],
};

describe('GitHubProvider', () => {
  it('reads a commit from whatever base url it was given', async () => {
    const { fetchImpl, seen } = stubFetch([
      (u) => (u.includes('/repos/acme/checkout-api/commits/b2c3d4') ? { body: commitBody } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://pub-r1--github.arga.test', token: 't', fetchImpl });
    const commit = await gh.getCommit('acme/checkout-api', 'b2c3d4');

    expect(commit.sha).toBe('b2c3d4');
    expect(commit.authorName).toBe('Dana');
    expect(commit.parents).toEqual(['a1b2c3']);
    expect(seen[0]).toContain('https://pub-r1--github.arga.test/repos/acme/checkout-api/commits/b2c3d4');
  });

  it('maps a compare response into changed files', async () => {
    const { fetchImpl } = stubFetch([
      (u) =>
        u.includes('/compare/a1b2c3...b2c3d4')
          ? {
              body: {
                files: [
                  { filename: 'src/checkout/service.ts', status: 'modified', additions: 12, deletions: 3, patch: '@@ -1 +1 @@' },
                  { filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0, previous_filename: 'src/older.ts' },
                ],
                commits: [commitBody],
              },
            }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    const diff = await gh.getDiff('acme/checkout-api', 'a1b2c3', 'b2c3d4');

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({ path: 'src/checkout/service.ts', status: 'modified', additions: 12 });
    expect(diff.files[1]).toMatchObject({ status: 'renamed', previousPath: 'src/older.ts' });
    expect(diff.patch).toContain('src/checkout/service.ts');
  });

  it('reports a missing patch as null rather than an empty string', async () => {
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/compare/') ? { body: { files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }] } } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    expect((await gh.getDiff('r/r', 'a', 'b')).patch).toBeNull();
  });

  it('decodes base64 file contents and returns null for a missing file', async () => {
    const { fetchImpl } = stubFetch([
      (u) =>
        u.includes('/contents/src/present.ts')
          ? { body: { content: Buffer.from('export const x = 1;').toString('base64'), encoding: 'base64' } }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    expect(await gh.getFile('r/r', 'main', 'src/present.ts')).toBe('export const x = 1;');
    expect(await gh.getFile('r/r', 'main', 'src/missing.ts')).toBeNull();
  });

  it('creates a fix branch and a pull request', async () => {
    const { fetchImpl, seen } = stubFetch([
      (u, i) =>
        u.endsWith('/git/refs') && i.method === 'POST'
          ? { status: 201, body: { ref: 'refs/heads/pager/incident-184', object: { sha: 'b2c3d4' } } }
          : undefined,
      (u, i) =>
        u.endsWith('/pulls') && i.method === 'POST'
          ? {
              status: 201,
              body: {
                number: 382,
                title: 'Fix null discount code',
                body: 'body',
                head: { ref: 'pager/incident-184', sha: 'c3' },
                base: { ref: 'main' },
                html_url: 'https://github.test/acme/checkout-api/pull/382',
                state: 'open',
              },
            }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 't', fetchImpl });

    const branch = await gh.createBranch('acme/checkout-api', 'b2c3d4', 'pager/incident-184');
    expect(branch.name).toBe('pager/incident-184');

    const pr = await gh.createPullRequest('acme/checkout-api', {
      title: 'Fix null discount code',
      body: 'body',
      headRef: 'pager/incident-184',
      baseRef: 'main',
    });
    expect(pr.number).toBe(382);
    expect(pr.state).toBe('open');
    expect(seen.filter((s) => s.startsWith('POST'))).toHaveLength(2);
  });

  it('reports a merged pull request distinctly from a closed one', async () => {
    const base = { number: 1, title: 't', body: null, head: { ref: 'h', sha: 's' }, base: { ref: 'main' }, html_url: 'u' };
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/pulls/1') ? { body: { ...base, state: 'closed', merged: true, merge_commit_sha: 'm1' } } : undefined),
      (u) => (u.includes('/pulls/2') ? { body: { ...base, number: 2, state: 'closed' } } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    expect((await gh.getPullRequest('r/r', 1)).state).toBe('merged');
    expect((await gh.getPullRequest('r/r', 2)).state).toBe('closed');
  });

  it('surfaces a destroyed twin environment distinctly from an ordinary failure', async () => {
    const { fetchImpl } = stubFetch([
      () => ({ status: 410, body: { error: 'environment_destroyed' } }),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://pub-r1--github.arga.test', fetchImpl });
    await expect(gh.getCommit('r/r', 'x')).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderHttpError && e.isEnvironmentDestroyed,
    );
  });

  // The token used to be embedded as x-access-token:…@ in the URL, which git
  // writes to .git/config and echoes in its errors.
  it('derives a git clone url from the api base url, with no credential in it', async () => {
    const { fetchImpl } = stubFetch([]);
    const twin = new GitHubProvider({ baseUrl: 'https://pub-r1--github.arga.test', token: 'ghs_tokentokentokentoken1234', fetchImpl });
    expect(twin.cloneUrl('acme/checkout-api')).toBe('https://pub-r1--github.arga.test/acme/checkout-api.git');

    const real = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 'ghs_tokentokentokentoken1234', fetchImpl });
    expect(real.cloneUrl('acme/checkout-api')).toBe('https://github.com/acme/checkout-api.git');
  });

  it('keeps the base path of a server that does not live at the root', async () => {
    const { fetchImpl } = stubFetch([]);
    const token = 'ghs_tokentokentokentoken1234';
    const ghes = new GitHubProvider({ baseUrl: 'https://ghe.example.com/api/v3', token, fetchImpl });
    expect(ghes.cloneUrl('acme/checkout-api')).toBe('https://ghe.example.com/acme/checkout-api.git');
    const prefixed = new GitHubProvider({ baseUrl: 'http://127.0.0.1:4600/github/', token, fetchImpl });
    expect(prefixed.cloneUrl('acme/checkout-api')).toBe('http://127.0.0.1:4600/github/acme/checkout-api.git');
  });

  it('authenticates git through an extra header in the environment, not argv or the URL', async () => {
    const { fetchImpl } = stubFetch([]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 'ghs_tokentokentokentoken1234', fetchImpl });
    const env = await gh.gitAuthEnvironment();
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_TERMINAL_PROMPT: '0' });
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from('x-access-token:ghs_tokentokentokentoken1234').toString('base64')}`,
    );
  });

  it('never lets a credential survive into an error message', async () => {
    // A vendor echoing the request is enough to put the token in a log line.
    const token = 'ghs_echoedechoedechoedechoed99';
    const { fetchImpl } = stubFetch([() => ({ status: 400, body: { message: `bad credentials: Bearer ${token}` } })]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', token, fetchImpl });
    const err = await gh.getCommit('acme/checkout-api', 'abc').catch((e: unknown) => e as ProviderHttpError);
    expect(err.message).not.toContain(token);
    expect(err.body).not.toContain(token);
    expect(err.message).toMatch(/REDACTED/);
  });
});

describe('GitHubProvider.mergePullRequest', () => {
  const pr = (over: object = {}) => ({
    number: 12, title: 't', body: '', head: { ref: 'pager/x', sha: 'a'.repeat(40) }, base: { ref: 'main' },
    html_url: 'https://github.test/pull/12', state: 'closed', merged: true, merged_at: '2026-09-13T15:00:00Z',
    merge_commit_sha: 'm'.repeat(40), ...over,
  });

  it('sends the reviewed sha', async () => {
    let sent: { sha?: string } = {};
    const { fetchImpl } = stubFetch([
      (u, init) => {
        if (init.method === 'PUT') {
          sent = JSON.parse(String(init.body)) as { sha?: string };
          return { body: { merged: true } };
        }
        return u.endsWith('/pulls/12') ? { body: pr() } : undefined;
      },
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.test', token: 't', fetchImpl });
    await gh.mergePullRequest('acme/checkout-api', 12, { sha: 'a'.repeat(40) });
    expect(sent.sha).toBe('a'.repeat(40));
  });

  it('raises PullRequestChangedError on 409', async () => {
    const { fetchImpl } = stubFetch([
      (_u, init) => (init.method === 'PUT' ? { status: 409, body: { message: 'Head branch was modified.' } } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.test', token: 't', fetchImpl });
    await expect(gh.mergePullRequest('acme/checkout-api', 12, { sha: 'a'.repeat(40) })).rejects.toBeInstanceOf(
      PullRequestChangedError,
    );
  });

  // The first PUT merged but its response was lost; the retry got 405, and the
  // person was told "Could not merge" about a merge that had happened.
  it('treats a retry refused because the first attempt landed as success', async () => {
    let puts = 0;
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT') {
        puts++;
        if (puts === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ message: 'Pull Request is not mergeable' }), { status: 405 });
      }
      return new Response(JSON.stringify(String(input).endsWith('/pulls/12') ? pr() : {}), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.test', token: 't', fetchImpl });
    const merged = await gh.mergePullRequest('acme/checkout-api', 12, { sha: 'a'.repeat(40) });
    expect(puts).toBe(2);
    expect(merged.state).toBe('merged');
  });

  it('still fails when the pull request is not in fact merged', async () => {
    const { fetchImpl } = stubFetch([
      (u, init) =>
        init.method === 'PUT'
          ? { status: 405, body: { message: 'Pull Request is not mergeable' } }
          : u.endsWith('/pulls/12')
            ? { body: pr({ state: 'open', merged: false, merged_at: null }) }
            : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.test', token: 't', fetchImpl });
    await expect(gh.mergePullRequest('acme/checkout-api', 12)).rejects.toThrow(/405/);
  });
});

describe('GitHubProvider diff fallbacks', () => {
  // These cover behaviour discovered against a real Arga GitHub twin on 2026-09-13:
  // the twin returns a correctly-shaped /compare response with an empty files array,
  // and an empty /pulls/{n}/files, because it stores the object graph without
  // computing diffs.

  it('falls back to tree comparison when compare returns no files', async () => {
    const trees: Record<string, unknown> = {
      base: { tree: [
        { path: 'package.json', type: 'blob', sha: 'p1' },
        { path: 'src/checkout/service.ts', type: 'blob', sha: 's1' },
        { path: 'src/legacy.ts', type: 'blob', sha: 'l1' },
      ] },
      head: { tree: [
        { path: 'package.json', type: 'blob', sha: 'p1' },
        { path: 'src/checkout/service.ts', type: 'blob', sha: 's2' },
        { path: 'src/checkout/types.ts', type: 'blob', sha: 't1' },
      ] },
    };
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/compare/') ? { body: { files: [], commits: [] } } : undefined),
      (u) => (u.includes('/git/trees/base') ? { body: trees.base } : undefined),
      (u) => (u.includes('/git/trees/head') ? { body: trees.head } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://twin.test', fetchImpl });
    const diff = await gh.getDiff('acme/checkout-api', 'base', 'head');

    expect(diff.files).toEqual([
      { path: 'src/checkout/service.ts', status: 'modified', additions: 0, deletions: 0 },
      { path: 'src/checkout/types.ts', status: 'added', additions: 0, deletions: 0 },
      { path: 'src/legacy.ts', status: 'removed', additions: 0, deletions: 0 },
    ]);
    // Line counts are unknown from trees alone, and are left at zero with a null
    // patch rather than invented.
    expect(diff.patch).toBeNull();
  });

  it('prefers the compare response when it does carry files', async () => {
    const { fetchImpl, seen } = stubFetch([
      (u) =>
        u.includes('/compare/')
          ? { body: { files: [{ filename: 'a.ts', status: 'modified', additions: 5, deletions: 1, patch: '@@' }] } }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', fetchImpl });
    const diff = await gh.getDiff('r/r', 'a', 'b');

    expect(diff.files[0]!.additions).toBe(5);
    expect(seen.some((s) => s.includes('/git/trees/'))).toBe(false);
  });

  it('reports an empty diff when both compare and trees are empty', async () => {
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/compare/') ? { body: { files: [] } } : undefined),
      (u) => (u.includes('/git/trees/') ? { body: { tree: [] } } : undefined),
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://twin.test', fetchImpl });
    expect((await gh.getDiff('r/r', 'a', 'b')).files).toEqual([]);
  });

  it('falls back to merged pull requests when commits/{sha}/pulls is empty', async () => {
    const { fetchImpl } = stubFetch([
      (u) => (u.includes('/commits/abc/pulls') ? { body: [] } : undefined),
      (u) =>
        u.includes('/pulls?') || u.endsWith('/pulls')
          ? {
              body: [
                { number: 1, title: 'Discount codes', body: null, head: { ref: 'f', sha: 'zzz' },
                  base: { ref: 'main' }, html_url: 'u', state: 'closed', merged: true, merge_commit_sha: 'abc' },
                { number: 2, title: 'Unrelated', body: null, head: { ref: 'g', sha: 'yyy' },
                  base: { ref: 'main' }, html_url: 'u2', state: 'open' },
              ],
            }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://twin.test', fetchImpl });
    const prs = await gh.listPullRequestsForCommit('acme/checkout-api', 'abc');

    expect(prs).toHaveLength(1);
    expect(prs[0]!.number).toBe(1);
  });
});

/**
 * Branch lookup.
 *
 * Added because a deployed watcher restarted and opened a third pull request for a
 * defect that already had two: its memory of what it had done did not survive the
 * process. A deterministically-named branch is a record that lives in the
 * repository, which outlives any process, so "has this already been worked" becomes
 * a question with a durable answer.
 */
describe('GitHubProvider pull request lookup', () => {
  // The fallback read one page of 100, so a repository with more history reported
  // "no pull request" for a commit whose pull request was simply further back.
  it('pages through every pull request when the direct route is empty', async () => {
    const pr = (n: number) => ({
      number: n, title: `#${n}`, body: '', head: { ref: `b${n}`, sha: `h${n}` }, base: { ref: 'main' },
      html_url: `https://github.test/pull/${n}`, state: 'closed', merged: true, merge_commit_sha: n === 140 ? 'target' : `m${n}`,
    });
    const { fetchImpl, seen } = stubFetch([
      (u) => (u.includes('/commits/target/pulls') ? { body: [] } : undefined),
      (u) => {
        if (!u.includes('/pulls?')) return undefined;
        const page = Number(new URL(u).searchParams.get('page'));
        const all = Array.from({ length: 150 }, (_, i) => pr(i + 1));
        return { body: all.slice((page - 1) * 100, page * 100) };
      },
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.test', token: 't', fetchImpl });
    const found = await gh.listPullRequestsForCommit('acme/checkout-api', 'target');
    expect(found.map((p) => p.number)).toEqual([140]);
    expect(seen.filter((s) => s.includes('/pulls?'))).toHaveLength(2);
  });
});

describe('GitHubProvider.getBranch', () => {
  it('returns the branch when the ref exists', async () => {
    const { fetchImpl, seen } = stubFetch([
      (u) =>
        u.includes('/git/ref/heads/pager/inc-be5404871b81')
          ? { body: { ref: 'refs/heads/pager/inc-be5404871b81', object: { sha: 'f00ba4', type: 'commit' } } }
          : undefined,
    ]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 't', fetchImpl });

    const branch = await gh.getBranch('acme/checkout-api', 'pager/inc-be5404871b81');
    expect(branch).not.toBeNull();
    expect(branch!.name).toBe('pager/inc-be5404871b81');
    expect(branch!.sha).toBe('f00ba4');
    expect(seen[0]).toContain('/git/ref/heads/pager/inc-be5404871b81');
  });

  it('returns null for a ref that does not exist, rather than throwing', async () => {
    // Absence is the expected answer most of the time — a caller should not need
    // try/catch for control flow.
    const { fetchImpl } = stubFetch([]);
    const gh = new GitHubProvider({ baseUrl: 'https://api.github.com', token: 't', fetchImpl });
    expect(await gh.getBranch('acme/checkout-api', 'pager/never-created')).toBeNull();
  });
});

// A model chooses which file to read. It must never be able to read outside the
// repository it was asked about.
describe('GitHubProvider path safety', () => {
  const gh = () => {
    const stub = stubFetch([(url) => (url.includes('/contents/') ? { body: { content: '', encoding: 'base64' } } : null)]);
    return { gh: new GitHubProvider({ baseUrl: 'https://api.github.com', token: 't', fetchImpl: stub.fetchImpl }), seen: stub.seen };
  };

  it('refuses a path that climbs out of the repository', async () => {
    const { gh: p, seen } = gh();
    await expect(p.getFile('acme/api', 'main', '../../other/secret/contents/.env')).rejects.toThrow(UnsafeRepositoryPathError);
    await expect(p.getFile('acme/api', 'main', 'src/./x.ts')).rejects.toThrow(UnsafeRepositoryPathError);
    expect(seen).toEqual([]);
  });

  it('encodes each segment of an ordinary path', async () => {
    const { gh: p, seen } = gh();
    await p.getFile('acme/api', 'main', 'src/a b/#x.ts');
    expect(seen[0]).toContain('/repos/acme/api/contents/src/a%20b/%23x.ts');
  });

  it('refuses a malformed repository name', async () => {
    const { gh: p } = gh();
    await expect(p.getFile('acme/api/../../x', 'main', 'a.ts')).rejects.toThrow(UnsafeRepositoryPathError);
  });
});
