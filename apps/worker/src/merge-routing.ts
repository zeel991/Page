import { AuditRepository, InstallationRepository, ServiceConfigRepository, SlackRepository, type Database } from '@pager/db';
import { GitHubProvider, type GitHubAppClient } from '@pager/providers';
import type { AutonomyLevel } from '@pager/core';
import type { MergeAuditEntry, MergeClick, MergeRoute, MergeRouting } from './merge-endpoint.ts';

/**
 * Routing a merge click, from the database.
 *
 *  - the Slack team names the workspace (a team is bound to one workspace);
 *  - the repository and the channel together name the service — the click must come
 *    from the channel that service reports to, always;
 *  - the Slack user must be an owner or admin of that workspace with this Slack id
 *    linked to their membership;
 *  - the GitHub token is that workspace's installation token, narrowed to the one
 *    repository.
 */
export function databaseMergeRouting(db: Database, github: GitHubAppClient): MergeRouting {
  const slack = new SlackRepository(db);
  const services = new ServiceConfigRepository(db);
  const installations = new InstallationRepository(db);
  const audit = new AuditRepository(db);

  return {
    async resolve(click: MergeClick): Promise<MergeRoute> {
      const team = click.teamId ? await slack.byTeamId(click.teamId) : null;
      if (!team) return { ok: false, reason: `Slack team ${click.teamId ?? 'unknown'} is not connected to a Pager Developer workspace`, organizationId: null };
      const org = team.organizationId;

      const watched = (await services.enabledWithRepository()).filter(
        (r) => r.service.organizationId === org && r.repository.fullName === click.repository,
      );
      if (watched.length === 0) return { ok: false, reason: `this workspace does not watch ${click.repository}`, organizationId: org };
      const match = watched.find((r) => r.service.slackChannelId === click.channelId);
      if (!match) return { ok: false, reason: 'the button was pressed outside the incident channel', organizationId: org };

      const approver = click.slackUserId ? await slack.approver(org, click.slackUserId) : null;
      if (!approver) {
        return {
          ok: false,
          reason: `${click.slackUserId ?? 'an unknown user'} is not an owner or admin of this workspace with a linked Slack identity`,
          organizationId: org,
        };
      }

      const installation = (await installations.active(org)).find((i) => i.id === match.repository.githubInstallationId);
      if (!installation) return { ok: false, reason: 'the GitHub App installation for this repository is gone or suspended', organizationId: org };
      const tokens = github.tokenSource(installation.installationId, match.repository.fullName);
      return {
        ok: true,
        organizationId: org,
        approver: { userId: approver.userId, name: approver.name },
        autonomy: (match.service.readOnly ? 'L2' : match.service.autonomyLevel) as AutonomyLevel,
        sourceControl: new GitHubProvider({ baseUrl: github.config.apiBaseUrl, tokenProvider: () => tokens.token() }),
      };
    },

    async record(entry: MergeAuditEntry): Promise<void> {
      // A click from an unconnected team belongs to no workspace, so there is no
      // workspace audit log to write it to; the refusal is still logged.
      if (!entry.organizationId) return;
      await audit.record({
        organizationId: entry.organizationId,
        actor: entry.approverUserId ? `user:${entry.approverUserId}` : `slack:${entry.slackUserId ?? 'unknown'}`,
        action: 'github.mergePullRequest',
        risk: 'PRODUCTION_WRITE',
        allowed: entry.allowed,
        denialReason: entry.allowed ? null : entry.outcome,
        detail: {
          approvalId: entry.approvalId,
          repository: entry.repository,
          pullRequest: entry.pullRequest,
          incidentKey: entry.incidentKey,
          headSha: entry.headSha,
          slackUserId: entry.slackUserId,
          outcome: entry.outcome,
        },
      });
    },
  };
}
