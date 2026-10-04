/**
 * Who runs this deployment, and how to reach them, for the pricing, legal and contact
 * pages. Read at request time, so one build serves any operator.
 *
 * A legal name and a support address are required to take payments (Dodo Payments
 * reviews them; `pnpm launch:check --payments` refuses a deployment without them).
 * A free beta may have neither: the operator is then the project's maintainers, and
 * the contact route is the project's issue tracker, never a made-up name or address.
 */
const PROJECT_ISSUES = 'https://github.com/zeel991/Page/issues';

export function operator() {
  const name = process.env.PAGER_LEGAL_NAME?.trim() || null;
  const email = process.env.PAGER_SUPPORT_EMAIL?.trim() || null;
  const issues = process.env.PAGER_SUPPORT_URL?.trim() || PROJECT_ISSUES;
  return {
    name,
    email,
    nameOrGap: name ?? 'the maintainers of the Pager Developer project',
    /** Where to write: the support address, or the project's issues. */
    contact: email
      ? { href: `mailto:${email}`, label: email, how: 'email' as const }
      : { href: issues, label: issues.replace(/^https?:\/\//, ''), how: 'issue' as const },
    effective: process.env.PAGER_LEGAL_EFFECTIVE_DATE?.trim() || null,
  };
}
