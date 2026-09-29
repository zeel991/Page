import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogs, memberships, eq } from '@pager/db';
import { harness, healthServer, onboard, type Harness } from '../../api/test/harness.ts';
import { databaseMergeRouting } from '../src/merge-routing.ts';

/**
 * Who may merge, decided from the database: the Slack team names the workspace, the
 * repository and channel name the service, and the clicker must be a linked owner or
 * admin. PAGER_MERGE_APPROVERS, a static list in the environment, is gone.
 */

let h: Harness;
let health: Awaited<ReturnType<typeof healthServer>>;
beforeEach(async () => {
  h = await harness();
  health = await healthServer(() => 'abc1234def');
});
afterEach(async () => {
  await health.close();
  await h.close();
});

const click = (over: Partial<Parameters<ReturnType<typeof databaseMergeRouting>['resolve']>[0]> = {}) => ({
  teamId: 'T0TWIN',
  slackUserId: 'U0OCTO',
  channelId: '#incidents',
  repository: 'acme/checkout-api',
  pullRequest: 1,
  ...over,
});

describe('database merge routing', () => {
  it('routes a click from the service’s channel by its workspace’s linked owner', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    const routing = databaseMergeRouting(h.handle.db, h.github);
    const route = await routing.resolve(click());
    expect(route).toMatchObject({ ok: true, organizationId: session.org, approver: { userId: session.userId }, autonomy: 'L3' });
  });

  it.each([
    ['a Slack team no workspace connected', { teamId: 'T0OTHER' }, /not connected/],
    ['a channel other than the service’s', { channelId: '#random' }, /outside the incident channel/],
    ['a Slack user with no linked membership', { slackUserId: 'U0STRANGER' }, /not an owner or admin/],
    ['a repository the workspace does not watch', { repository: 'acme/settlement-api' }, /does not watch/],
  ])('refuses %s', async (_label, over, reason) => {
    await onboard(h, { healthUrl: health.url });
    const route = await databaseMergeRouting(h.handle.db, h.github).resolve(click(over));
    expect(route.ok).toBe(false);
    expect(!route.ok && route.reason).toMatch(reason);
  });

  it('refuses a plain member even with a linked Slack identity', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    await h.handle.db.update(memberships).set({ role: 'member' }).where(eq(memberships.userId, session.userId));
    const route = await databaseMergeRouting(h.handle.db, h.github).resolve(click());
    expect(!route.ok && route.reason).toMatch(/not an owner or admin/);
  });

  it('writes every decision to the workspace’s audit log', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    const routing = databaseMergeRouting(h.handle.db, h.github);
    await routing.record({
      organizationId: session.org, approvalId: 'a1', repository: 'acme/checkout-api', pullRequest: 1,
      incidentKey: 'INC-1', headSha: 'a'.repeat(40), approverUserId: session.userId, slackUserId: 'U0OCTO', allowed: true, outcome: 'merged',
    });
    const rows = await h.handle.db.select().from(auditLogs).where(eq(auditLogs.action, 'github.mergePullRequest'));
    expect(rows).toEqual([expect.objectContaining({ organizationId: session.org, actor: `user:${session.userId}`, allowed: true, risk: 'PRODUCTION_WRITE' })]);
  });
});
