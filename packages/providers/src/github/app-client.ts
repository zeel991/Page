import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderHttpError } from '../http.js';
import { GitHubAppTokenSource, signAppJwt, type GitHubAppCredentials } from './app-auth.js';

/**
 * The operator's GitHub App, as the product talks to it.
 *
 * One app serves every workspace; each workspace is an installation of it. This is
 * the app-level surface: where to send someone to install it, proving that the
 * person claiming an installation can see it, what an installation covers, and
 * checking that a webhook really came from GitHub.
 */

export interface GitHubAppConfig extends GitHubAppCredentials {
  slug: string;
  /** The app's OAuth client, used for sign-in and for install-time verification. */
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** https://api.github.com, or a twin. */
  apiBaseUrl: string;
  /** https://github.com, or a twin. */
  webBaseUrl: string;
}

export interface InstallationInfo {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

export interface InstallationRepository {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export class GitHubInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubInstallError';
  }
}

const PAGE = 100;
const MAX_PAGES = 50;

export class GitHubAppClient {
  private readonly api: string;
  private readonly web: string;

  constructor(
    readonly config: GitHubAppConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.api = config.apiBaseUrl.replace(/\/+$/, '');
    this.web = config.webBaseUrl.replace(/\/+$/, '');
  }

  /** Where to send a workspace owner to install the app. `state` ties the return to them. */
  installUrl(state: string): string {
    return `${this.web}/apps/${encodeURIComponent(this.config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** Exchange the OAuth code GitHub appends to the setup redirect for a user-to-server token. */
  async exchangeCode(code: string): Promise<string> {
    const res = await this.fetchImpl(`${this.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
    // GitHub reports a bad code with 200 and an `error` field.
    if (!res.ok || !body.access_token) {
      throw new GitHubInstallError(`GitHub would not exchange the authorisation code (${body.error ?? res.status}).`);
    }
    return body.access_token;
  }

  /** Installations of this app that the person holding `userToken` can access. */
  async userInstallationIds(userToken: string): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.get<{ installations?: { id: number }[] }>(`/user/installations?per_page=${PAGE}&page=${page}`, userToken);
      const batch = body.installations ?? [];
      ids.push(...batch.map((i) => i.id));
      if (batch.length < PAGE) return ids;
    }
    throw new GitHubInstallError('The user can see more installations than this client will page through.');
  }

  async installation(installationId: number): Promise<InstallationInfo> {
    const body = await this.get<{
      id: number;
      account?: { login?: string; type?: string };
      repository_selection?: 'all' | 'selected';
      suspended_at?: string | null;
    }>(`/app/installations/${installationId}`, signAppJwt(this.config));
    return {
      id: body.id,
      accountLogin: body.account?.login ?? 'unknown',
      accountType: body.account?.type ?? 'unknown',
      repositorySelection: body.repository_selection ?? 'selected',
      suspended: Boolean(body.suspended_at),
    };
  }

  /** Every repository an installation covers, paged in full. */
  async installationRepositories(installationId: number): Promise<InstallationRepository[]> {
    const token = await new GitHubAppTokenSource(this.api, this.config, { installationId, fetchImpl: this.fetchImpl }).token();
    const out: InstallationRepository[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.get<{ repositories?: { full_name: string; default_branch?: string; private?: boolean }[] }>(
        `/installation/repositories?per_page=${PAGE}&page=${page}`,
        token,
      );
      const batch = body.repositories ?? [];
      out.push(...batch.map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch ?? 'main', private: r.private ?? true })));
      if (batch.length < PAGE) return out;
    }
    throw new GitHubInstallError('The installation covers more repositories than this client will page through.');
  }

  /**
   * A token for one repository of one installation.
   *
   * Narrowed to that repository, so a job for one service cannot write to another
   * repository the customer installed the app on.
   */
  tokenSource(installationId: number, repositoryFullName: string): GitHubAppTokenSource {
    const name = repositoryFullName.split('/')[1];
    if (!name) throw new GitHubInstallError(`Not a repository full name: ${repositoryFullName}`);
    return new GitHubAppTokenSource(this.api, this.config, { installationId, repositories: [name], fetchImpl: this.fetchImpl });
  }

  /** Whether `X-Hub-Signature-256` is GitHub's HMAC of exactly this body. */
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!signatureHeader?.startsWith('sha256=')) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', this.config.webhookSecret).update(rawBody).digest('hex')}`);
    const given = Buffer.from(signatureHeader);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private async get<T>(path: string, bearer: string): Promise<T> {
    const url = `${this.api}${path}`;
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new ProviderHttpError(res.status, 'GET', url, await res.text());
    return (await res.json()) as T;
  }
}
