import { registerSecret, type ChangedFile, type Commit } from '@pager/core';
import { Http, ProviderHttpError } from '../http.js';
import { UnsafeRepositoryPathError, segment } from '../path-guard.js';

export { UnsafeRepositoryPathError, segment };
import type {
  Branch,
  CommitComparison,
  CommitFilesInput,
  CreatePullRequestInput,
  Diff,
  PullRequest,
  SourceControlProvider,
} from '../types.js';

/**
 * GitHub source control adapter.
 *
 * Written against the real GitHub REST v3 API. An Arga GitHub twin exposes the same
 * endpoints, so this one implementation serves the twin, a self-hosted GitHub
 * Enterprise instance and api.github.com — only the base URL and token differ. There
 * is deliberately no `if (arga)` anywhere in this file.
 */

interface GhCommitDetail {
  message?: string;
  author?: { name: string; email?: string; date: string };
}

/**
 * Either commit shape GitHub returns.
 *
 * REST Commits nests under `commit`; the Git Data API returns the same fields at
 * the top level. Both are modelled so `toCommit` can accept either.
 */
interface GhCommitResponse extends GhCommitDetail {
  sha: string;
  commit?: GhCommitDetail;
  parents?: { sha: string }[];
  files?: GhFile[];
}

interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previous_filename?: string;
  patch?: string;
}

interface GhCompareResponse {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  files?: GhFile[];
  commits?: GhCommitResponse[];
}

interface GhTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GhTreeResponse {
  tree?: GhTreeEntry[];
}

interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
}

const FILE_STATUS: Record<string, ChangedFile['status']> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  changed: 'modified',
};


/** The pull request's head moved after it was reviewed; GitHub refused the merge (409). */
export class PullRequestChangedError extends Error {
  constructor(
    readonly pullRequest: number,
    readonly reviewedSha: string | null,
  ) {
    super(
      `#${pullRequest} changed since it was reviewed` +
        (reviewedSha ? ` (reviewed at ${reviewedSha.slice(0, 12)})` : '') +
        `; GitHub refused to merge a head nobody approved.`,
    );
    this.name = 'PullRequestChangedError';
  }
}

// Path components chosen by a model are validated and encoded, so `../` cannot walk
// out of the repository into any other the token can see; see path-guard.ts.
const REPO_PART = /^[A-Za-z0-9_.-]+$/;

export function repoPath(repo: string): string {
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((p) => !REPO_PART.test(p) || p === '.' || p === '..')) {
    throw new UnsafeRepositoryPathError('repository', repo);
  }
  return parts.map(encodeURIComponent).join('/');
}


export function refPath(path: string): string {
  const parts = path.replace(/^\/+/, '').split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new UnsafeRepositoryPathError('path', path);
  return parts.map(encodeURIComponent).join('/');
}

export interface GitHubProviderOptions {
  baseUrl: string;
  token?: string;
  /**
   * Resolves a bearer token per request. Used for GitHub App installation tokens,
   * which expire and must be reminted; takes precedence over a static `token`.
   */
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof globalThis.fetch;
}

export class GitHubProvider implements SourceControlProvider {
  readonly kind = 'source-control' as const;
  private readonly http: Http;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly tokenProvider: (() => Promise<string>) | undefined;

  constructor(opts: GitHubProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.tokenProvider = opts.tokenProvider;
    this.http = new Http({
      baseUrl: this.baseUrl,
      headers: {
        ...(opts.token && !opts.tokenProvider ? { authorization: `Bearer ${opts.token}` } : {}),
        'x-github-api-version': '2022-11-28',
      },
      ...(opts.tokenProvider
        ? { dynamicHeaders: async () => ({ authorization: `Bearer ${await opts.tokenProvider!()}` }) }
        : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  /** Current credential. Never logged, never put in a URL. */
  private async currentToken(): Promise<string | undefined> {
    if (this.tokenProvider) return this.tokenProvider();
    return this.token;
  }

  /**
   * Environment that authenticates `git` to this host, for a clone or fetch.
   *
   * The credential travels as an `http.extraHeader` set through git's
   * GIT_CONFIG_* variables: never in the URL, so it cannot land in `.git/config`,
   * in a remote listing or in an error that echoes the URL; and never in argv, so
   * it is not visible in the process table. Requires git 2.31 or later.
   */
  async gitAuthEnvironment(): Promise<Record<string, string>> {
    const token = await this.currentToken();
    const base = { GIT_TERMINAL_PROMPT: '0' };
    if (!token) return base;
    registerSecret(token);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      ...base,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  }

  async getCommit(repo: string, sha: string): Promise<Commit> {
    const res = await this.http.get<GhCommitResponse>(`/repos/${repoPath(repo)}/commits/${segment(sha)}`);
    return toCommit(res);
  }

  /**
   * The diff between two revisions.
   *
   * `/compare` is the direct route and is what real GitHub answers. Some
   * GitHub-compatible implementations — including the Arga twin — return the correct
   * compare schema with an empty `files` array, because they store the object graph
   * but do not compute diffs. Rather than reporting "nothing changed" (which an
   * investigation would read as a real absence and could use to exonerate a
   * deployment), an empty compare falls back to diffing the two git trees directly.
   *
   * Tree comparison is not an approximation: comparing blob shas path-by-path is
   * what a diff is. It costs the line counts, which are reported as zero and
   * flagged via `patch: null` rather than invented.
   */
  async getDiff(repo: string, baseSha: string, headSha: string): Promise<Diff> {
    const res = await this.http.get<GhCompareResponse>(
      `/repos/${repoPath(repo)}/compare/${segment(baseSha)}...${segment(headSha)}`,
    );
    const files = res.files ?? [];

    if (files.length === 0) {
      const fromTrees = await this.diffTrees(repo, baseSha, headSha);
      if (fromTrees.length > 0) {
        return { baseSha, headSha, files: fromTrees, patch: null };
      }
    }

    return {
      baseSha,
      headSha,
      files: files.map(toChangedFile),
      // Reassembled from per-file patches; null rather than an empty string when the
      // provider gave us nothing, so "no patch available" is distinguishable from
      // "an empty patch".
      patch: files.some((f) => f.patch)
        ? files
            .filter((f) => f.patch)
            .map((f) => `--- ${f.filename}\n${f.patch}`)
            .join('\n')
        : null,
    };
  }

  async listCommitsBetween(repo: string, baseSha: string, headSha: string): Promise<Commit[]> {
    const res = await this.http.get<GhCompareResponse>(
      `/repos/${repoPath(repo)}/compare/${segment(baseSha)}...${segment(headSha)}`,
    );
    return (res.commits ?? []).map(toCommit);
  }

  async compareCommits(repo: string, baseSha: string, headSha: string): Promise<CommitComparison> {
    const res = await this.http.get<GhCompareResponse>(
      `/repos/${repoPath(repo)}/compare/${segment(baseSha)}...${segment(headSha)}`,
      { per_page: 1 },
    );
    const status = res.status;
    if (status !== 'identical' && status !== 'ahead' && status !== 'behind' && status !== 'diverged') {
      // An unrecognised or missing status is not "ahead": ancestry decides whether a
      // fix is deployed, so it is never assumed.
      throw new Error(`GitHub compare returned no usable status (${JSON.stringify(status ?? null)}).`);
    }
    return { status, aheadBy: res.ahead_by ?? 0, behindBy: res.behind_by ?? 0 };
  }

  /** Recursive tree for a revision, as a path -> blob sha map. */
  private async treeMap(repo: string, sha: string): Promise<Map<string, string>> {
    const res = await this.http.getOptional<GhTreeResponse>(
      `/repos/${repoPath(repo)}/git/trees/${segment(sha)}`,
      { recursive: 1 },
    );
    const map = new Map<string, string>();
    for (const entry of res?.tree ?? []) {
      if (entry.type === 'blob') map.set(entry.path, entry.sha);
    }
    return map;
  }

  /** Changed files derived by comparing two revisions' trees. */
  private async diffTrees(repo: string, baseSha: string, headSha: string): Promise<ChangedFile[]> {
    const [base, head] = await Promise.all([
      this.treeMap(repo, baseSha),
      this.treeMap(repo, headSha),
    ]);
    if (base.size === 0 && head.size === 0) return [];

    const changed: ChangedFile[] = [];
    for (const [path, sha] of head) {
      const before = base.get(path);
      if (before === undefined) {
        changed.push({ path, status: 'added', additions: 0, deletions: 0 });
      } else if (before !== sha) {
        changed.push({ path, status: 'modified', additions: 0, deletions: 0 });
      }
    }
    for (const path of base.keys()) {
      if (!head.has(path)) {
        changed.push({ path, status: 'removed', additions: 0, deletions: 0 });
      }
    }
    return changed.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listCommits(repo: string, opts: { ref?: string; limit?: number } = {}): Promise<Commit[]> {
    const res = await this.http.get<GhCommitResponse[]>(`/repos/${repoPath(repo)}/commits`, {
      ...(opts.ref ? { sha: opts.ref } : {}),
      per_page: opts.limit ?? 30,
    });
    return (res ?? []).map(toCommit);
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const res = await this.http.get<GhPullRequest>(`/repos/${repoPath(repo)}/pulls/${segment(String(number))}`);
    return toPullRequest(res);
  }

  /**
   * Pull requests associated with a commit.
   *
   * `/commits/{sha}/pulls` is the direct route, but not every GitHub-compatible
   * implementation provides it. Rather than reporting "no pull requests" — which
   * downstream would read as a real absence — an empty or missing result falls back
   * to matching the commit against merged pull requests' merge commits.
   */
  async listPullRequestsForCommit(repo: string, sha: string): Promise<PullRequest[]> {
    const direct = await this.http.getOptional<GhPullRequest[]>(
      `/repos/${repoPath(repo)}/commits/${segment(sha)}/pulls`,
    );
    if (direct && direct.length > 0) return direct.map(toPullRequest);

    const all = await this.http.getOptional<GhPullRequest[]>(`/repos/${repoPath(repo)}/pulls`, {
      state: 'all',
      per_page: 100,
    });
    return (all ?? [])
      .filter((pr) => pr.merge_commit_sha === sha || pr.head?.sha === sha)
      .map(toPullRequest);
  }

  async getFile(repo: string, ref: string, path: string): Promise<string | null> {
    const res = await this.http.getOptional<{ content?: string; encoding?: string }>(
      `/repos/${repoPath(repo)}/contents/${refPath(path)}`,
      { ref },
    );
    if (!res?.content) return null;
    return res.encoding === 'base64'
      ? Buffer.from(res.content, 'base64').toString('utf8')
      : res.content;
  }

  async listFiles(repo: string, ref: string): Promise<string[]> {
    const res = await this.http.getOptional<GhTreeResponse>(`/repos/${repoPath(repo)}/git/trees/${segment(ref)}`, {
      recursive: 1,
    });
    return (res?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path).sort();
  }

  async createBranch(repo: string, fromSha: string, name: string): Promise<Branch> {
    const res = await this.http.post<{ ref: string; object: { sha: string } }>(
      `/repos/${repoPath(repo)}/git/refs`,
      { ref: `refs/heads/${name}`, sha: fromSha },
    );
    return { name: res.ref.replace(/^refs\/heads\//, ''), sha: res.object.sha };
  }

  /**
   * Merge a pull request.
   *
   * GitHub answers 405 when the pull request is not mergeable — conflicts, a failing
   * required check, a branch protection rule. That is surfaced rather than retried:
   * a merge that the repository's own rules refuse is a decision, not a transient
   * failure, and working around it would defeat the point of having the rules.
   *
   * With `sha`, GitHub merges only if the head is still that commit and answers 409
   * otherwise, which is raised as `PullRequestChangedError`.
   *
   * A PUT that failed in transit is retried, and if the first attempt in fact landed
   * the retry is refused with 405 "not mergeable" — because it is merged. So any
   * failure is followed by a read: merged at the expected head is success.
   */
  async mergePullRequest(
    repo: string,
    number: number,
    opts: { method?: 'merge' | 'squash' | 'rebase'; commitTitle?: string; sha?: string } = {},
  ): Promise<PullRequest> {
    try {
      await this.http.put<{ merged: boolean; sha?: string; message?: string }>(
        `/repos/${repoPath(repo)}/pulls/${segment(String(number))}/merge`,
        {
          merge_method: opts.method ?? 'squash',
          ...(opts.commitTitle ? { commit_title: opts.commitTitle } : {}),
          ...(opts.sha ? { sha: opts.sha } : {}),
        },
      );
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 409) {
        throw new PullRequestChangedError(number, opts.sha ?? null);
      }
      const after = await this.getPullRequest(repo, number).catch(() => null);
      if (after?.state === 'merged' && (!opts.sha || after.headSha === opts.sha)) return after;
      throw err;
    }
    // Read the pull request back rather than trusting the merge response: the
    // authoritative record of what happened is the pull request's own state.
    return this.getPullRequest(repo, number);
  }

  async getBranch(repo: string, name: string): Promise<Branch | null> {
    const res = await this.http.getOptional<{ ref: string; object: { sha: string } }>(
      `/repos/${repoPath(repo)}/git/ref/heads/${refPath(name)}`,
    );
    return res ? { name: res.ref.replace(/^refs\/heads\//, ''), sha: res.object.sha } : null;
  }

  async createPullRequest(repo: string, input: CreatePullRequestInput): Promise<PullRequest> {
    const res = await this.http.post<GhPullRequest>(`/repos/${repoPath(repo)}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.headRef,
      base: input.baseRef,
      draft: input.draft ?? false,
    });
    return toPullRequest(res);
  }

  /**
   * Commit file changes onto a branch using the Git Data API.
   *
   * Blobs, then a tree layered on the branch's current tree, then a commit, then a
   * ref update — the same four steps real GitHub requires. Doing it properly rather
   * than through a convenience endpoint means this works against api.github.com,
   * an enterprise instance and a twin without branching.
   */
  async commitFiles(repo: string, input: CommitFilesInput): Promise<Commit> {
    const ref = await this.http.get<{ object: { sha: string } }>(
      `/repos/${repoPath(repo)}/git/ref/heads/${refPath(input.branch)}`,
    );
    const parentSha = ref.object.sha;
    const parentCommit = await this.http.get<{ tree: { sha: string } }>(
      `/repos/${repoPath(repo)}/git/commits/${segment(parentSha)}`,
    );

    const tree: Record<string, unknown>[] = [];
    for (const change of input.changes) {
      if (change.content === null) {
        // A null sha removes the path from the tree, which is how the API deletes.
        tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await this.http.post<{ sha: string }>(`/repos/${repoPath(repo)}/git/blobs`, {
        content: Buffer.from(change.content, 'utf8').toString('base64'),
        encoding: 'base64',
      });
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const newTree = await this.http.post<{ sha: string }>(`/repos/${repoPath(repo)}/git/trees`, {
      base_tree: parentCommit.tree.sha,
      tree,
    });

    const commit = await this.http.post<GhCommitResponse>(`/repos/${repoPath(repo)}/git/commits`, {
      message: input.message,
      tree: newTree.sha,
      parents: [parentSha],
      ...(input.author ? { author: { name: input.author, email: `${input.author}@pager.local` } } : {}),
    });

    await this.http.patch(`/repos/${repoPath(repo)}/git/refs/heads/${refPath(input.branch)}`, {
      sha: commit.sha,
      force: false,
    });

    return toCommit(commit);
  }

  /**
   * Clone URL for the reproduction sandbox.
   *
   * Derived from the API base URL so a twin clones from the twin. It carries no
   * credential: that is supplied by `gitAuthEnvironment`, because a token in a URL
   * is written into `.git/config` and echoed by every git error that prints it.
   */
  cloneUrl(repo: string): string {
    const url = new URL(this.baseUrl);
    // api.github.com/repos/... is served from github.com for git operations.
    const host = url.host.startsWith('api.') ? url.host.slice(4) : url.host;
    return `${url.protocol}//${host}/${repoPath(repo)}.git`;
  }
}

/**
 * Normalise a commit from either of GitHub's two commit shapes.
 *
 * The REST Commits API nests the message and author under `commit`, while the Git
 * Data API (`/git/commits`, which is what creating a commit returns) puts them at
 * the top level. They describe the same object and differ only in shape, so a
 * reader written for one throws on the other — `res.commit.author` is undefined
 * against the Git Data response, which surfaces as a bare "Cannot read properties
 * of undefined" with nothing naming the cause.
 *
 * Observed against api.github.com while committing a fix to a real repository.
 */
function toCommit(res: GhCommitResponse): Commit {
  const detail = res.commit ?? res;
  const author = detail.author ?? { name: 'unknown', date: new Date(0).toISOString() };
  return {
    sha: res.sha,
    message: detail.message ?? '',
    authorName: author.name,
    ...(author.email ? { authorEmail: author.email } : {}),
    committedAt: new Date(author.date),
    parents: (res.parents ?? []).map((p) => p.sha),
  };
}

function toChangedFile(f: GhFile): ChangedFile {
  return {
    path: f.filename,
    status: FILE_STATUS[f.status] ?? 'modified',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
  };
}

function toPullRequest(pr: GhPullRequest): PullRequest {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    url: pr.html_url,
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    mergeCommitSha: pr.merge_commit_sha ?? null,
    headSha: pr.head.sha,
    mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
  };
}

export { ProviderHttpError };
