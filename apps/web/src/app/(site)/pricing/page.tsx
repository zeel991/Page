import Link from 'next/link';
import { DocPage } from '@/components/site/doc-page';
import { operator } from '@/lib/operator';
import { planFacts, priceLabel, type PlanOffer } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

/** Public, and unauthenticated: the plans and what Dodo Payments says they cost. */
async function plans(): Promise<{ enabled: boolean; plans: PlanOffer[] } | null> {
  const base = process.env.PAGER_API_URL ?? 'http://127.0.0.1:4000';
  try {
    const res = await fetch(`${base}/public/plans`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as { enabled: boolean; plans: PlanOffer[] }) : null;
  } catch {
    return null;
  }
}

export default async function PricingPage() {
  const data = await plans();
  const { email } = operator();
  return (
    <DocPage eyebrow="Plans" title="Pricing">
      <p>
        Pager Developer watches a service in production, and when a deployment breaks it, investigates, reproduces the
        failure, and opens a pull request with a tested fix. A person on your team reviews and merges it. It never merges
        or deploys on its own.
      </p>
      {!data ? (
        <p className="text-carbon/70">Plans could not be loaded just now. {email ? <>Ask us at <a href={`mailto:${email}`}>{email}</a>.</> : null}</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {data.plans.map((p) => (
            <section key={p.id} className="rounded-md border border-carbon/15 bg-white/50 p-6">
              <h2 className="!mt-0">{p.name}</h2>
              <p className="display mt-2 text-[28px]">{priceLabel(p)}</p>
              {p.purchasable && p.price?.recurring && <p className="text-[12px] text-carbon/60">Billed in advance, renews until cancelled. Taxes are added at checkout where they apply.</p>}
              <ul className="mt-4 space-y-1 text-[14px]">
                {planFacts(p).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <p>
        Start on the free plan by <Link href="/signin">signing up with GitHub</Link>; upgrade from Settings → Plan and billing
        once you are in. Cancel any time from the same place; the plan stays until the end of the period you paid for. See the{' '}
        <Link href="/refunds">refund and cancellation policy</Link>.
      </p>
      <p className="text-[13px] text-carbon/70">
        Payments are processed by Dodo Payments, which acts as the merchant of record: the charge on your statement comes from
        them, and they handle sales tax and VAT.
      </p>
    </DocPage>
  );
}
