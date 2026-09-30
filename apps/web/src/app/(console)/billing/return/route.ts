import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import { apiCall } from '@/lib/api';

/**
 * Where Dodo's checkout sends the person back, with `?subscription_id=…&status=…`.
 *
 * Those parameters are the browser's word, so they only ask the API to look: it reads
 * the subscription from Dodo and applies it if Dodo ties it to this workspace. The
 * signed webhook settles it either way.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const subscriptionId = q.get('subscription_id');
  if (!subscriptionId) redirect('/settings?notice=billing_incomplete#billing');
  const r = await apiCall<{ pending?: boolean; applied?: boolean; planId?: string }>('/api/billing/refresh', { method: 'POST', body: { subscriptionId } });
  const notice = r.ok && r.body.applied && r.body.planId && r.body.planId !== 'free' ? 'billing_active' : q.get('status') === 'active' || r.body.pending ? 'billing_pending' : 'billing_incomplete';
  redirect(`/settings?notice=${notice}#billing`);
}
