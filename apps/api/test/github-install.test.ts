import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, installThroughGitHub, type Harness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

async function connect(session: { token: string }, opts: { login?: string; repositories?: string[] } = {}) {
  const { url } = (await h.call('GET', '/api/github/install-url', session.token)).json() as { url: string };
  const callback = await installThroughGitHub(url, opts);
  const res = await h.call('POST', '/api/github/setup', session.token, callback);
  return { res, callback };
}

describe('GitHub App installation', () => {
  it('binds an installation to the workspace that started it, and lists its repositories', async () => {
    const alice = await h.signIn('octo', '1001');
    const { res } = await connect(alice, { repositories: ['acme/checkout-api'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ installation: { accountLogin: 'octo', repositorySelection: 'selected' } });

    const repos = (await h.call('GET', '/api/github/repositories', alice.token)).json() as { repositories: { fullName: string; picked: boolean }[] };
    expect(repos.repositories).toEqual([expect.objectContaining({ fullName: 'acme/checkout-api', picked: false })]);

    const picked = await h.call('POST', '/api/repositories', alice.token, { fullName: 'acme/checkout-api' });
    expect(picked.statusCode).toBe(200);
    expect((await h.call('GET', '/api/repositories', alice.token)).json()).toMatchObject({
      repositories: [expect.objectContaining({ fullName: 'acme/checkout-api', defaultBranch: 'main' })],
    });
  });

  // The setup URL carries an installation id; on its own it would let anyone attach
  // an installation they can guess to their own workspace.
  it('refuses a callback replayed into another workspace', async () => {
    const alice = await h.signIn('octo', '1001');
    const mallory = await h.signIn('mallory', '6666');
    const { url } = (await h.call('GET', '/api/github/install-url', alice.token)).json() as { url: string };
    const callback = await installThroughGitHub(url);
    const res = await h.call('POST', '/api/github/setup', mallory.token, callback);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'state_mismatch' });
  });

  it('refuses an installation the installer cannot see on GitHub', async () => {
    const alice = await h.signIn('octo', '1001');
    // Another twin user, with no access to installation 1.
    h.twin.current.githubUsers.set(2002, { id: 2002, login: 'eve', name: 'Eve', email: null, installations: [] });
    const { url } = (await h.call('GET', '/api/github/install-url', alice.token)).json() as { url: string };
    const own = await installThroughGitHub(url, { login: 'eve' });
    // Eve's code, but claiming the seeded installation 1, which Eve cannot access.
    const res = await h.call('POST', '/api/github/setup', alice.token, { ...own, installationId: 1 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'not_your_installation' });
  });

  it('refuses an installation already connected to another workspace', async () => {
    const alice = await h.signIn('octo', '1001');
    const { callback } = await connect(alice);
    const bob = await h.signIn('bob', '1002');
    const { url } = (await h.call('GET', '/api/github/install-url', bob.token)).json() as { url: string };
    const bobs = await installThroughGitHub(url);
    // Bob (as the same GitHub user) tries to claim Alice's installation for his workspace.
    const res = await h.call('POST', '/api/github/setup', bob.token, { ...bobs, installationId: callback.installationId });
    expect(res.statusCode).toBe(409);
  });

  it('will not add a repository the installation does not cover', async () => {
    const alice = await h.signIn('octo', '1001');
    await connect(alice, { repositories: ['acme/checkout-api'] });
    const res = await h.call('POST', '/api/repositories', alice.token, { fullName: 'acme/settlement-api' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an expired or foreign state', async () => {
    const alice = await h.signIn('octo', '1001');
    const res = await h.call('POST', '/api/github/setup', alice.token, { installationId: 1, state: 'forged.state', code: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_state' });
  });
});

describe('GitHub webhooks', () => {
  const deliver = (event: string, payload: object, secret = h.github.config.webhookSecret) => {
    const body = JSON.stringify(payload);
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      payload: body,
    });
  };

  it('refuses a delivery GitHub did not sign', async () => {
    expect((await deliver('installation', { action: 'deleted', installation: { id: 1 } }, 'wrong-secret')).statusCode).toBe(401);
  });

  it('detaches repositories when the app is uninstalled or a repository removed', async () => {
    const alice = await h.signIn('octo', '1001');
    const { callback } = await connect(alice);
    await h.call('POST', '/api/repositories', alice.token, { fullName: 'acme/checkout-api' });

    expect((await deliver('installation_repositories', {
      action: 'removed', installation: { id: callback.installationId }, repositories_removed: [{ full_name: 'acme/checkout-api' }],
    })).statusCode).toBe(200);
    expect((await h.call('GET', '/api/repositories', alice.token)).json()).toEqual({ repositories: [] });

    await deliver('installation', { action: 'deleted', installation: { id: callback.installationId } });
    const list = (await h.call('GET', '/api/github/installations', alice.token)).json() as { installations: { removedAt: string | null }[] };
    expect(list.installations[0]!.removedAt).not.toBeNull();
  });
});
