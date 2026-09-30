import { DocPage } from '@/components/site/doc-page';
import { operator } from '@/lib/operator';

export const dynamic = 'force-dynamic';

export default function RefundsPage() {
  const { email, nameOrGap } = operator();
  const write = email ? <a href={`mailto:${email}`}>{email}</a> : 'the support address on the contact page';
  return (
    <DocPage eyebrow="Policy" title="Refunds and cancellation">
      <p>This policy covers paid plans of Pager Developer, operated by {nameOrGap}. Payments are processed by Dodo Payments as merchant of record.</p>
      <h2>Cancelling</h2>
      <ul>
        <li>An owner of a workspace can cancel at any time from Settings → Plan and billing → Manage billing.</li>
        <li>Cancellation stops the next renewal. The paid plan stays in effect until the end of the period already paid for, and the workspace then returns to the free plan. Nothing is deleted when a plan ends.</li>
      </ul>
      <h2>Refunds</h2>
      <ul>
        <li>If you were charged in error, charged twice, or the service did not work for you, write to {write} within 14 days of the charge and it will be refunded in full.</li>
        <li>Outside those 14 days, periods already started are not refunded, except where the law where you live requires it.</li>
        <li>Refunds go back to the original payment method through Dodo Payments and usually arrive within 5–10 business days, depending on your bank.</li>
      </ul>
      <h2>Failed payments</h2>
      <p>If a renewal fails, Dodo Payments retries it. While it is being retried the paid plan continues; if it cannot be collected, the workspace returns to the free plan until payment succeeds.</p>
    </DocPage>
  );
}
