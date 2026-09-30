import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { apiCall } from '@/lib/api';
import { noticeFor } from '@/lib/notices';

/**
 * Slack's redirect URI. The code is exchanged by the API, which writes the bot token
 * straight into the vault; the token never reaches this server or the browser.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  if (q.get('error')) redirect('/onboarding?notice=slack_denied');
  const code = q.get('code');
  const state = q.get('state');
  if (!code || !state) redirect('/onboarding?notice=invalid_state');
  const r = await apiCall('/api/slack/oauth', { method: 'POST', body: { code, state } });
  redirect(`/onboarding?notice=${r.ok ? 'slack_connected' : noticeFor(r.status, r.body.error)}`);
}
