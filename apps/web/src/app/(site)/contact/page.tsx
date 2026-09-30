import { DocPage } from '@/components/site/doc-page';
import { operator } from '@/lib/operator';

export const dynamic = 'force-dynamic';

export default function ContactPage() {
  const { email, nameOrGap } = operator();
  return (
    <DocPage eyebrow="Support" title="Contact">
      <p>Pager Developer is operated by {nameOrGap}.</p>
      {email ? (
        <p>
          For support, billing, refunds, data deletion or anything else, email <a href={`mailto:${email}`}>{email}</a>. A person
          reads it and replies within two business days.
        </p>
      ) : (
        <p>No support address is configured for this deployment (PAGER_SUPPORT_EMAIL).</p>
      )}
      <p>
        To report a security vulnerability, use GitHub&apos;s private vulnerability reporting on the{' '}
        <a href="https://github.com/zeel991/Page/security" target="_blank" rel="noreferrer">project repository</a>.
      </p>
    </DocPage>
  );
}
