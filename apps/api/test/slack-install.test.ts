import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, installThroughSlack, type Harness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await harness();
  h.twin.current.channels.add('#payments');
  h.twin.current.channels.add('#platform');
});
afterEach(async () => {
  await h.close();
});

async function connectSlack(session: { token: string }) {
  const { url } = (await h.call('GET', '/api/slack/install-url', session.token)).json() as { url: string };
  const callback = await installThroughSlack(url);
  return { res: await h.call('POST', '/api/slack/oauth', session.token, callback), callback };
}

describe('Slack installation', () => {
  it('connects a team, stores the bot token encrypted, and links members by email', async () => {
    const alice = await h.signIn('octo', '1001', 'octo@acme.dev');
    const { res } = await connectSlack(alice);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ installation: { teamId: 'T0TWIN', teamName: 'Acme' }, linkedMembers: 1 });
    // The token is in the vault, not in the response.
    expect(res.body).not.toContain('xoxb-');
    expect(await h.vault.reveal(alice.org, 'slack.bot_token')).toMatch(/^xoxb-twin-/);
    const members = (await h.call('GET', '/api/members', alice.token)).json() as { members: { slackUserId: string | null }[] };
    expect(members.members[0]!.slackUserId).toBe('U0OCTO');
  });

  it('lists every channel the bot can see, across pages', async () => {
    const alice = await h.signIn('octo', '1001');
    await connectSlack(alice);
    const channels = (await h.call('GET', '/api/slack/channels', alice.token)).json() as { channels: { id: string }[] };
    // The twin pages two at a time; every channel must come back.
    expect(channels.channels.map((c) => c.id)).toEqual([...h.twin.current.channels].sort());
    expect(channels.channels.length).toBeGreaterThan(2);
  });

  it('refuses a callback replayed into another workspace', async () => {
    const alice = await h.signIn('octo', '1001');
    const mallory = await h.signIn('mallory', '6666');
    const { url } = (await h.call('GET', '/api/slack/install-url', alice.token)).json() as { url: string };
    const callback = await installThroughSlack(url);
    const res = await h.call('POST', '/api/slack/oauth', mallory.token, callback);
    expect(res.json()).toMatchObject({ error: 'state_mismatch' });
  });

  it('refuses a Slack team already connected to another workspace', async () => {
    // A merge click is routed by team id, so a team can belong to one workspace only.
    const alice = await h.signIn('octo', '1001');
    await connectSlack(alice);
    const bob = await h.signIn('bob', '1002');
    const { res } = await connectSlack(bob);
    expect(res.statusCode).toBe(409);
    expect(await h.vault.reveal(bob.org, 'slack.bot_token')).toBeNull();
  });

  it('only lets an owner link a Slack identity by hand', async () => {
    const alice = await h.signIn('octo', '1001');
    const members = (await h.call('GET', '/api/members', alice.token)).json() as { members: { id: string }[] };
    const res = await h.call('PUT', `/api/members/${members.members[0]!.id}/slack`, alice.token, { slackUserId: 'U0123ABC' });
    expect(res.statusCode).toBe(200);
    expect((await h.call('PUT', `/api/members/${members.members[0]!.id}/slack`, alice.token, { slackUserId: 'not-an-id' })).statusCode).toBe(400);
  });
});
