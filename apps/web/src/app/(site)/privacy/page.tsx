import Link from 'next/link';
import { DocPage } from '@/components/site/doc-page';
import { operator } from '@/lib/operator';

export const dynamic = 'force-dynamic';

export default function PrivacyPage() {
  const { email, nameOrGap } = operator();
  return (
    <DocPage eyebrow="Policy" title="Privacy">
      <p>This describes what Pager Developer, operated by {nameOrGap}, collects, why, who it is shared with, and how to have it deleted.</p>
      <h2>What we collect</h2>
      <ul>
        <li><strong>Your GitHub profile</strong> when you sign in: your GitHub user id, login, name, avatar and, if GitHub shares it, your email.</li>
        <li><strong>Workspace configuration</strong>: members and roles, connected repositories, services, Slack channels, and settings.</li>
        <li><strong>Credentials you connect</strong> (Datadog, Sentry, Notion, Resend, Anthropic keys, the Slack bot token). They are encrypted with a separate key per secret and are never shown back in full.</li>
        <li><strong>What an investigation reads</strong>: alerts, error logs and metrics from your monitoring, and the repository at the deployed revision. The repository is cloned into a short-lived sandbox that is deleted when the run ends.</li>
        <li><strong>What an investigation produces</strong>: incidents, evidence, reproduction results, proposed patches, pull requests, audit records, and model usage and cost.</li>
        <li><strong>Billing records</strong>: your plan, subscription status and Dodo Payments customer and subscription ids. Card details go to Dodo Payments and never reach us.</li>
      </ul>
      <p>We use a single session cookie to keep you signed in. There is no advertising or third-party tracking on this site.</p>
      <h2>Why</h2>
      <p>Only to provide the service: detect and investigate incidents, propose fixes, notify your team, bill for paid plans, and keep the service secure. We do not sell personal data or use your code or telemetry to train models.</p>
      <h2>Who it is shared with</h2>
      <ul>
        <li><strong>Anthropic</strong>, our model provider: excerpts of telemetry and code relevant to an incident, to analyse it and write a fix.</li>
        <li><strong>GitHub, Slack, and the monitoring, Notion and email accounts you connect</strong>: we read from and write to them on your behalf.</li>
        <li><strong>Dodo Payments</strong>: to take payment, as merchant of record.</li>
        <li><strong>Hosting</strong>: Vercel (this site), Render (the API and database) and our worker hosts.</li>
        <li><strong>Lemma</strong>, where tracing is enabled for this deployment: records of agent runs, for debugging the service.</li>
      </ul>
      <p>We disclose data to authorities only when legally required, and tell affected workspaces unless we are prohibited from doing so.</p>
      <h2>How long</h2>
      <p>Sandboxes, and the code in them, are deleted at the end of each run. Everything else is kept while your workspace exists. When a workspace is deleted, its data is removed within 30 days, apart from billing records the law requires us to keep.</p>
      <h2>Your choices</h2>
      <p>
        An owner or admin can replace a stored credential from Settings at any time. To disconnect an integration and delete its
        credential, get a copy of your data, correct it, or delete your account or workspace, {email ? <>email <a href={`mailto:${email}`}>{email}</a></> : <>use the <Link href="/contact">contact page</Link></>}.
        Depending on where you live you may have further rights, including to complain to your data protection authority.
      </p>
    </DocPage>
  );
}
