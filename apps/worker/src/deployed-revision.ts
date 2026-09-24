import { UnsafeUrlError, safeGet, type DeploymentRecord, type SafeResponse, type SourceControlProvider } from '@pager/providers';

/**
 * What is production actually running?
 *
 * Asked of the service itself, not inferred. The running process reports the commit
 * it was built from — Render injects `RENDER_GIT_COMMIT`, and most platforms provide
 * an equivalent — so the answer comes from the thing being investigated rather than
 * from a branch that has since moved on.
 *
 * This is the load-bearing input for everything downstream: a patch validated
 * against a tree that is not the failing one proves nothing. So when the service
 * cannot say, the worker is told, and it halts rather than guessing.
 */

export interface DeployedRevisionProbe {
  sha: string | null;
  reportedAt: Date;
  /** Everything the health endpoint said, for the record. */
  raw: unknown;
  problem: string | null;
}

const COMMIT_KEYS = ['commit', 'revision', 'sha', 'version', 'build', 'gitCommit', 'git_commit'];

export interface ProbeOptions {
  /** Private addresses and plain http, for local drills only. Tenant URLs never get this. */
  allowPrivate?: boolean;
  /** Attempts for a rate-limited, failing or unreachable endpoint. */
  attempts?: number;
  /** Injected in tests. */
  get?: (url: string) => Promise<SafeResponse>;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;
const MAX_WAIT_MS = 10_000;

/** How long to wait before the next attempt: Retry-After when the server says, otherwise backoff. */
function waitFor(attempt: number, retryAfter: string | string[] | undefined): number {
  const header = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  return Math.min(1_000 * 3 ** attempt, MAX_WAIT_MS);
}

/**
 * Ask the service which commit it is running.
 *
 * The URL is tenant-supplied, so it is fetched through the SSRF-safe client. A
 * rate-limited (429) or failing (5xx) endpoint, or a cold start, is retried with
 * backoff before the tick gives up — one throttled request used to skip the whole
 * check, silently, every time.
 */
export async function probeDeployedRevision(healthUrl: string, opts: ProbeOptions = {}): Promise<DeployedRevisionProbe> {
  const get = opts.get ?? ((url: string) => safeGet(url, { timeoutMs: 20_000, allowPrivate: opts.allowPrivate ?? false }));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, opts.attempts ?? 3);

  let problem = 'health endpoint was not reached';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const at = new Date();
    let res: SafeResponse;
    try {
      res = await get(healthUrl);
    } catch (err) {
      // A URL refused as unsafe will not become safe on retry.
      if (err instanceof UnsafeUrlError) {
        return { sha: null, reportedAt: at, raw: null, problem: `health URL refused: ${err.message}` };
      }
      problem = `health endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < attempts - 1) await sleep(waitFor(attempt, undefined));
      continue;
    }

    if (res.status < 200 || res.status >= 300) {
      problem = `health endpoint returned ${res.status}${attempts > 1 ? ` after ${attempt + 1} attempt(s)` : ''}`;
      if (RETRYABLE(res.status) && attempt < attempts - 1) {
        await sleep(waitFor(attempt, res.headers['retry-after']));
        continue;
      }
      return { sha: null, reportedAt: at, raw: null, problem };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      return { sha: null, reportedAt: at, raw: null, problem: 'health endpoint did not return JSON' };
    }
    for (const key of COMMIT_KEYS) {
      const value = body[key];
      // A full 40-character sha, or an abbreviation long enough to be unambiguous.
      if (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value)) {
        return { sha: value, reportedAt: at, raw: body, problem: null };
      }
    }
    return {
      sha: null,
      reportedAt: at,
      raw: body,
      problem:
        `the service is healthy but reports no commit. Expose the build revision on the ` +
        `health endpoint (on Render, process.env.RENDER_GIT_COMMIT) so the revision under ` +
        `investigation is observed rather than assumed.`,
    };
  }
  return { sha: null, reportedAt: new Date(), raw: null, problem };
}

/**
 * Turn an observed revision into a deployment record.
 *
 * The predecessor is the deployed commit's first parent — the prior state of the
 * branch production tracks. The previous entry in a commit log is whatever a merge
 * brought in, and diffing against that yields nothing, which would silently present
 * as "the deployment changed nothing".
 */
export async function deploymentFromRevision(
  sourceControl: SourceControlProvider,
  opts: { repository: string; service: string; sha: string; observedAt: Date },
): Promise<DeploymentRecord> {
  const head = await sourceControl.getCommit(opts.repository, opts.sha);
  return {
    id: `render-${head.sha.slice(0, 12)}`,
    service: opts.service,
    environment: 'production',
    commitSha: head.sha,
    previousCommitSha: head.parents[0] ?? null,
    status: 'succeeded',
    startedAt: head.committedAt,
    deployedAt: head.committedAt,
    author: head.authorName,
    repositoryFullName: opts.repository,
  };
}
