import { DocPage } from '@/components/site/doc-page';
import { operator } from '@/lib/operator';

export const dynamic = 'force-dynamic';

export default function ContactPage() {
  const { contact, nameOrGap } = operator();
  return (
    <DocPage eyebrow="Support" title="Contact">
      <p>Pager Developer is operated by {nameOrGap}.</p>
      {contact.how === 'email' ? (
        <p>
          For support, billing, refunds, data deletion or anything else, email <a href={contact.href}>{contact.label}</a>. A person
          reads it and replies within two business days.
        </p>
      ) : (
        <p>
          For support, data deletion or anything else, open an issue at{' '}
          <a href={contact.href} target="_blank" rel="noreferrer">{contact.label}</a>. For anything private, say so in the issue
          and a maintainer will arrange another way to talk.
        </p>
      )}
      <p>
        To report a security vulnerability, use GitHub&apos;s private vulnerability reporting on the{' '}
        <a href="https://github.com/zeel991/Page/security" target="_blank" rel="noreferrer">project repository</a>.
      </p>
    </DocPage>
  );
}
