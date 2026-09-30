import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { apiCall } from '@/lib/api';
import { noticeFor } from '@/lib/notices';

/**
 * GitHub's setup URL: where the browser lands after installing the app.
 *
 * The query carries an installation id anyone could type, so it proves nothing on
 * its own. The API checks the signed state and asks GitHub, with the installer's
 * own OAuth code, whether this person can see that installation.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  if (q.get('setup_action') === 'request') redirect('/onboarding?notice=github_requested');
  const installationId = q.get('installation_id');
  const state = q.get('state');
  const code = q.get('code');
  if (!code) redirect('/onboarding?notice=github_no_code');
  if (!installationId || !state) redirect('/onboarding?notice=invalid_state');
  const r = await apiCall('/api/github/setup', { method: 'POST', body: { installationId, state, code } });
  redirect(`/onboarding?notice=${r.ok ? 'github_connected' : noticeFor(r.status, r.body.error)}`);
}
