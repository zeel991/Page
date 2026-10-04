import Link from 'next/link';
import { DocPage } from '@/components/site/doc-page';
import { operator } from '@/lib/operator';

export const dynamic = 'force-dynamic';

export default function TermsPage() {
  const { contact, nameOrGap } = operator();
  return (
    <DocPage eyebrow="Policy" title="Terms of service">
      <p>
        These terms govern your use of Pager Developer (&ldquo;the service&rdquo;), operated by {nameOrGap} (&ldquo;we&rdquo;). By
        signing up you agree to them on behalf of yourself and the workspace you create or join.
      </p>
      <h2>1. The service</h2>
      <p>
        The service watches software services you connect, and when a deployment appears to have broken one, investigates it,
        reproduces the failure in an isolated sandbox, and may open a pull request against your repository with a proposed fix
        and the evidence for it. It never merges a pull request or deploys anything on its own; a merge happens only when a
        person you authorise makes it. You are responsible for reviewing anything it proposes before you merge it.
      </p>
      <h2>2. Accounts and workspaces</h2>
      <ul>
        <li>You sign in with GitHub. You must be allowed to act for the GitHub organisation, repositories and other accounts you connect.</li>
        <li>Owners and admins of a workspace decide what it connects and who belongs to it, and are responsible for their members&apos; use.</li>
        <li>Keep access to your GitHub account secure; activity under it is treated as yours.</li>
      </ul>
      <h2>3. Your code and data</h2>
      <p>
        You keep all rights to your code, telemetry and other content. You permit us to read the repositories and telemetry you
        connect, to run your repository&apos;s code and tests in sandboxes, to send excerpts to our model provider for analysis,
        and to write branches and pull requests to your repositories, all only to provide the service. How we handle this data is
        described in the <Link href="/privacy">privacy policy</Link>.
      </p>
      <h2>4. Acceptable use</h2>
      <ul>
        <li>Do not connect repositories or accounts you are not authorised to use.</li>
        <li>Do not use the service to run code designed to attack, escape or overload it, other customers, or third parties.</li>
        <li>Do not resell the service or use it to build a competing dataset of other customers&apos; information.</li>
      </ul>
      <p>We may suspend a workspace that breaks these rules or endangers other customers, and will tell its owners why.</p>
      <h2>5. Plans and payment</h2>
      <p>
        The free plan and paid plans, their limits and prices are listed on the <Link href="/pricing">pricing page</Link>. Paid
        plans are subscriptions billed in advance and renewed each period until cancelled. Payments are processed by Dodo Payments
        as merchant of record, whose terms also apply to the purchase. Cancellation and refunds are covered by the{' '}
        <Link href="/refunds">refund policy</Link>. We will give at least 30 days&apos; notice before changing the price of a plan you
        are on.
      </p>
      <h2>6. Availability and changes</h2>
      <p>
        We work to keep the service available but do not guarantee it will be uninterrupted or that every incident will be
        detected, diagnosed or fixed. Features may change; we will not remove a paid feature during a period you have paid for.
      </p>
      <h2>7. Disclaimer and liability</h2>
      <p>
        The service is provided &ldquo;as is&rdquo;. To the extent the law allows, we disclaim implied warranties, and our total
        liability for any claim is limited to the amount you paid us in the 12 months before it. We are not liable for indirect or
        consequential losses, including losses from merging a proposed change.
      </p>
      <h2>8. Ending</h2>
      <p>You may stop using the service and ask us to delete your workspace at any time. We may end these terms with 30 days&apos; notice, or at once for a serious breach.</p>
      <h2>9. Changes to these terms</h2>
      <p>We will post changes here and notify workspace owners of material ones by email at least 14 days before they apply.</p>
      <h2>10. Contact</h2>
      <p>Questions about these terms: <a href={contact.href}>{contact.label}</a>, or see the <Link href="/contact">contact page</Link>.</p>
    </DocPage>
  );
}
