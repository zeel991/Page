import { redirect } from 'next/navigation';
import { apiCall } from '@/lib/api';
import { noticeFor } from '@/lib/notices';

/** Start a GitHub App install: the API signs a state bound to this workspace and person. */
export async function GET() {
  const r = await apiCall<{ url: string }>('/api/github/install-url');
  if (!r.ok) redirect(`/onboarding?notice=${noticeFor(r.status, r.body.error)}`);
  redirect(r.body.url);
}
