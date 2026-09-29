import { Http } from '../http.js';

/**
 * The operator's Slack app, as each workspace installs it (OAuth v2).
 *
 * Installing yields a bot token for one Slack team. Everything a workspace does in
 * Slack afterwards uses that token; the operator's own credentials are only the
 * client id and secret that complete the install.
 */

export interface SlackAppConfig {
  clientId: string;
  clientSecret: string;
  /** https://slack.com, or a twin. */
  baseUrl: string;
}

/** What the bot needs: post, read channel lists, and match members by email. */
export const SLACK_BOT_SCOPES = ['chat:write', 'channels:read', 'groups:read', 'users:read', 'users:read.email'];

export interface SlackInstall {
  botToken: string;
  teamId: string;
  teamName: string;
  botUserId: string | null;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export class SlackInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackInstallError';
  }
}

interface Ok {
  ok: boolean;
  error?: string;
}

export class SlackAppClient {
  private readonly base: string;

  constructor(
    readonly config: SlackAppConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.base = config.baseUrl.replace(/\/+$/, '');
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.config.clientId, scope: SLACK_BOT_SCOPES.join(','), redirect_uri: redirectUri, state });
    return `${this.base}/oauth/v2/authorize?${q}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<SlackInstall> {
    const res = await this.fetchImpl(`${this.base}/api/oauth.v2.access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, redirect_uri: redirectUri }),
    });
    const body = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as Ok & {
      access_token?: string;
      bot_user_id?: string;
      team?: { id?: string; name?: string };
    };
    if (!body.ok || !body.access_token || !body.team?.id) {
      throw new SlackInstallError(`Slack would not complete the install (${body.error ?? 'no token'}).`);
    }
    return { botToken: body.access_token, teamId: body.team.id, teamName: body.team.name ?? body.team.id, botUserId: body.bot_user_id ?? null };
  }

  /** Every channel the bot can see, following the cursor. */
  async channels(botToken: string): Promise<SlackChannel[]> {
    const http = this.http(botToken);
    const out: SlackChannel[] = [];
    let cursor = '';
    for (let page = 0; page < 50; page++) {
      const body = await http.get<Ok & {
        channels?: { id: string; name: string; is_private?: boolean; is_member?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }>('/api/conversations.list', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: 200, ...(cursor ? { cursor } : {}) });
      if (!body.ok) throw new SlackInstallError(`Slack conversations.list failed: ${body.error}`);
      out.push(...(body.channels ?? []).map((c) => ({ id: c.id, name: c.name, isPrivate: c.is_private ?? false, isMember: c.is_member ?? false })));
      cursor = body.response_metadata?.next_cursor ?? '';
      if (!cursor) return out;
    }
    throw new SlackInstallError('More channels than this client will page through.');
  }

  /** The Slack user with this email, or null. */
  async userIdByEmail(botToken: string, email: string): Promise<string | null> {
    const body = await this.http(botToken).get<Ok & { user?: { id?: string } }>('/api/users.lookupByEmail', { email });
    return body.ok ? (body.user?.id ?? null) : null;
  }

  /** Whether the token still works, and which team it belongs to. */
  async authTest(botToken: string): Promise<{ ok: true; teamId: string } | { ok: false; error: string }> {
    const body = await this.http(botToken).post<Ok & { team_id?: string }>('/api/auth.test', {});
    return body.ok && body.team_id ? { ok: true, teamId: body.team_id } : { ok: false, error: body.error ?? 'unknown' };
  }

  private http(botToken: string): Http {
    return new Http({ baseUrl: this.base, headers: { authorization: `Bearer ${botToken}` }, fetchImpl: this.fetchImpl });
  }
}
