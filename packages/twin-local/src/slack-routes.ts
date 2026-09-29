import type { Route } from './router.js';

/**
 * Slack Web API surface.
 *
 * Reproduces Slack's convention of answering HTTP 200 with `{ ok: false, error }`
 * for application-level failures, so the adapter's `ok` checking is exercised rather
 * than bypassed by a twin that always succeeds.
 */
export function slackRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/api\/chat\.postMessage$/,
      handler: (ctx) => {
        const body = ctx.json as { channel?: string; text?: string; thread_ts?: string; blocks?: unknown };
        const channel = body.channel ?? '';
        if (!channel) return { status: 200, body: { ok: false, error: 'invalid_arguments' } };
        if (!ctx.state.channels.has(channel)) {
          return { status: 200, body: { ok: false, error: 'channel_not_found' } };
        }

        const ts = `${(ctx.now() / 1000).toFixed(6)}`;
        ctx.state.messages.push({
          ts,
          channel,
          threadTs: body.thread_ts ?? null,
          text: body.text ?? '',
          blocks: body.blocks ?? null,
        });
        return { status: 200, body: { ok: true, ts, channel } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/conversations\.replies$/,
      handler: (ctx) => {
        const channel = ctx.query.channel ?? '';
        const ts = ctx.query.ts ?? '';
        if (!ctx.state.channels.has(channel)) {
          return { status: 200, body: { ok: false, error: 'channel_not_found' } };
        }
        const messages = ctx.state.messages.filter(
          (m) => m.channel === channel && (m.ts === ts || m.threadTs === ts),
        );
        // Paged like Slack, with a small page so callers must follow the cursor.
        const start = Number(ctx.query.cursor ?? 0);
        const size = Math.min(Number(ctx.query.limit ?? 1000), 2);
        const next = start + size;
        return {
          status: 200,
          body: {
            ok: true,
            messages: messages.slice(start, next).map((m) => ({ ts: m.ts, text: m.text, thread_ts: m.threadTs })),
            has_more: next < messages.length,
            ...(next < messages.length ? { response_metadata: { next_cursor: String(next) } } : {}),
          },
        };
      },
    },
    {
      // Paged by cursor, two at a time, so callers must follow it.
      method: 'GET',
      pattern: /^\/api\/conversations\.list$/,
      handler: (ctx) => {
        const all = [...ctx.state.channels].sort();
        const start = Number(ctx.query.cursor ?? 0);
        const next = start + Math.min(Number(ctx.query.limit ?? 100), 2);
        return {
          status: 200,
          body: {
            ok: true,
            channels: all.slice(start, next).map((name) => ({ id: name, name: name.replace(/^#/, ''), is_private: false, is_member: true })),
            response_metadata: { next_cursor: next < all.length ? String(next) : '' },
          },
        };
      },
    },

    // ── Installing the app into a workspace (OAuth v2) ───────────────────────
    {
      // Stands in for slack.com's consent screen: approves at once and redirects
      // back with a code and the caller's state.
      method: 'GET',
      pattern: /^\/oauth\/v2\/authorize$/,
      handler: (ctx) => {
        if (ctx.query.client_id !== ctx.state.slack.app.clientId) return { status: 400, body: 'invalid_client_id' };
        const redirect = ctx.query.redirect_uri;
        if (!redirect) return { status: 400, body: 'missing redirect_uri' };
        const code = `slack-code-${Math.random().toString(36).slice(2)}`;
        ctx.state.slack.codes.set(code, true);
        const target = new URL(redirect);
        target.searchParams.set('code', code);
        if (ctx.query.state) target.searchParams.set('state', ctx.query.state);
        return { status: 302, headers: { location: target.toString() }, body: '' };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/oauth\.v2\.access$/,
      handler: (ctx) => {
        const body = { ...Object.fromEntries(ctx.form), ...((ctx.json as Record<string, string> | null) ?? {}) } as Record<string, string>;
        const app = ctx.state.slack.app;
        if (body.client_id !== app.clientId || body.client_secret !== app.clientSecret) {
          return { status: 200, body: { ok: false, error: 'invalid_client' } };
        }
        if (!body.code || !ctx.state.slack.codes.has(body.code)) return { status: 200, body: { ok: false, error: 'invalid_code' } };
        ctx.state.slack.codes.delete(body.code);
        const token = `xoxb-twin-${Math.random().toString(36).slice(2)}`;
        ctx.state.slack.botTokens.add(token);
        return {
          status: 200,
          body: {
            ok: true,
            access_token: token,
            token_type: 'bot',
            scope: 'chat:write,channels:read,groups:read,users:read,users:read.email',
            bot_user_id: 'U0BOT',
            team: { ...ctx.state.slack.team },
          },
        };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/auth\.test$/,
      handler: (ctx) => {
        const token = (ctx.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!ctx.state.slack.botTokens.has(token)) return { status: 200, body: { ok: false, error: 'invalid_auth' } };
        return { status: 200, body: { ok: true, team: ctx.state.slack.team.name, team_id: ctx.state.slack.team.id, user_id: 'U0BOT' } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/users\.lookupByEmail$/,
      handler: (ctx) => {
        const user = ctx.state.slack.users.find((u) => u.email && u.email === ctx.query.email);
        if (!user) return { status: 200, body: { ok: false, error: 'users_not_found' } };
        return { status: 200, body: { ok: true, user: { id: user.id, name: user.name, profile: { email: user.email } } } };
      },
    },
  ];
}
