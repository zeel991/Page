/**
 * Who runs this deployment, for the pricing, legal and contact pages. Read at request
 * time, so one build serves any operator. Unset values are shown as unset, never
 * filled with a made-up name; the launch check (pnpm launch:check) refuses them.
 */
export function operator() {
  const name = process.env.PAGER_LEGAL_NAME?.trim() || null;
  const email = process.env.PAGER_SUPPORT_EMAIL?.trim() || null;
  return {
    name,
    email,
    /** "Acme Ltd" or, when unset, a phrase that reads as a gap rather than a party. */
    nameOrGap: name ?? 'the operator of this deployment (PAGER_LEGAL_NAME is not set)',
    effective: process.env.PAGER_LEGAL_EFFECTIVE_DATE?.trim() || null,
  };
}
