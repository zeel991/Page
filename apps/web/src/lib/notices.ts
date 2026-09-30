/**
 * What an install callback reports back to the checklist.
 *
 * Only a code travels in the URL, and the page renders the fixed sentence for it: a
 * query string is attacker-chosen, so no text from it is ever shown as ours.
 */
export const NOTICES: Record<string, { tone: 'ok' | 'error'; text: string }> = {
  github_connected: { tone: 'ok', text: 'GitHub App installed. Pick the repositories to watch.' },
  github_requested: { tone: 'ok', text: 'Installation requested. An owner of that GitHub organization has to approve it; come back here once they have.' },
  github_no_code: {
    tone: 'error',
    text: 'GitHub did not send an authorization code, so the installation could not be proven yours. The app must have “Request user authorization (OAuth) during installation” enabled.',
  },
  not_your_installation: { tone: 'error', text: 'GitHub does not list that installation among the ones you can access, so it was not connected.' },
  installation_claimed: { tone: 'error', text: 'That GitHub installation is already connected to another Pager Developer workspace.' },
  github_refused: { tone: 'error', text: 'GitHub refused the exchange. Start the install again.' },
  github_app_not_configured: { tone: 'error', text: 'This deployment has no GitHub App configured.' },
  slack_connected: { tone: 'ok', text: 'Slack connected. Members whose GitHub email matches their Slack email were linked.' },
  slack_denied: { tone: 'error', text: 'The Slack install was cancelled.' },
  team_claimed: { tone: 'error', text: 'That Slack workspace is already connected to another Pager Developer workspace.' },
  slack_refused: { tone: 'error', text: 'Slack refused the exchange. Start the install again.' },
  slack_app_not_configured: { tone: 'error', text: 'This deployment has no Slack app configured.' },
  state_mismatch: { tone: 'error', text: 'That install was started from a different workspace or by a different person, so it was not connected.' },
  invalid_state: { tone: 'error', text: 'That install link has expired or was altered. Start it again from here.' },
  forbidden: { tone: 'error', text: 'Only an owner or admin of this workspace can connect it.' },
  failed: { tone: 'error', text: 'The install could not be completed. Start it again.' },
  billing_active: { tone: 'ok', text: 'Payment confirmed by Dodo Payments. This workspace is on its paid plan.' },
  billing_pending: { tone: 'ok', text: 'Checkout finished. Dodo Payments is confirming the subscription; the plan below updates within a minute or two.' },
  billing_incomplete: { tone: 'error', text: 'The checkout did not finish, so this workspace’s plan is unchanged.' },
};

/** The notice code for an API refusal: its own error code when we have a sentence for it. */
export function noticeFor(status: number, error: string | undefined): string {
  if (error && error in NOTICES) return error;
  return status === 403 ? 'forbidden' : 'failed';
}
