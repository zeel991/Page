/** A plan as the API offers it, with the price Dodo Payments states for its product. */
export interface PlanOffer {
  id: string;
  name: string;
  maxServices: number;
  maxIncidentsPerMonth: number;
  includedModelUsd: number | null;
  price: { amount: number; currency: string; interval: string | null; intervalCount: number | null; recurring: boolean } | null;
  purchasable: boolean;
}

/** "$49 / month". Null price on a purchasable plan: unknown right now, never "free". */
export function priceLabel(plan: PlanOffer): string {
  if (!plan.purchasable) return plan.id === 'free' ? 'Free' : 'Not offered';
  if (!plan.price) return 'Price unavailable right now';
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: plan.price.currency, minimumFractionDigits: plan.price.amount % 100 ? 2 : 0 }).format(plan.price.amount / 100);
  if (!plan.price.recurring || !plan.price.interval) return amount;
  const unit = plan.price.interval.toLowerCase();
  const every = plan.price.intervalCount && plan.price.intervalCount > 1 ? `${plan.price.intervalCount} ${unit}s` : unit;
  return `${amount} / ${every}`;
}

export function planFacts(plan: PlanOffer): string[] {
  return [
    `${plan.maxServices} watched service${plan.maxServices === 1 ? '' : 's'}`,
    `${plan.maxIncidentsPerMonth} investigated incidents a month`,
    plan.includedModelUsd == null ? 'Bring your own Anthropic key (Settings → Model key)' : `$${plan.includedModelUsd} of model usage included a month, or bring your own key`,
  ];
}

/** Plans a visitor can actually be on: the free plan, and paid plans that can be bought here. */
export function offeredPlans(plans: PlanOffer[]): PlanOffer[] {
  return plans.filter((p) => p.purchasable || p.id === 'free');
}
