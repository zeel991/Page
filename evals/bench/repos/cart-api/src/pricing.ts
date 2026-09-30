import { invariant } from './invariant.ts';
import { exchangeRate } from './rates.ts';

export interface Line {
  sku: string;
  unitPriceCents: number;
  quantity?: number;
}

export interface Discount {
  code: string;
  percentOff: number;
}

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'refunded';

const TAX_RATES: Record<string, { percent: number }> = {
  'us-east': { percent: 7 },
  'us-west': { percent: 8.25 },
  'eu-central': { percent: 19 },
};
const DEFAULT_TAX = { percent: 0 };
const MAX_SHIPPING_CENTS = 5_000;

export function lineTotalCents(line: Line): number {
  const total = line.unitPriceCents * (line.quantity ?? 1);
  invariant(total > 0, `line total for ${line.sku} must be positive, got ${total}`);
  return total;
}

export function subtotalCents(lines: Line[]): number {
  let sum = 0;
  for (let i = 0; i < lines.length; i++) {
    sum += lineTotalCents(lines[i]!);
  }
  return sum;
}

export function discountCents(subtotal: number, discount?: Discount): number {
  if (!discount) return 0;
  return Math.round(subtotal * (discount.percentOff / 100));
}

export function taxCents(amount: number, region: string): number {
  const rate = TAX_RATES[region] ?? DEFAULT_TAX;
  return Math.round(amount * (rate.percent / 100));
}

/** Shipping is $2.99 plus $1 per started kilogram. */
export function shippingCents(weightGrams: number): number {
  const fee = 299 + Math.ceil(weightGrams / 1000) * 100;
  invariant(fee <= MAX_SHIPPING_CENTS, `shipping fee ${fee} exceeds the cap`);
  return fee;
}

export function statusLabel(status: OrderStatus): string {
  switch (status) {
    case 'pending':
      return 'Awaiting payment';
    case 'paid':
      return 'Paid';
    case 'shipped':
      return 'On its way';
    case 'refunded':
      return 'Refunded';
    default:
      throw new Error(`unhandled order status "${status as string}"`);
  }
}

/** Split a total into equal instalments, the remainder on the first. */
export function instalmentCents(totalCents: number, instalments: number): number[] {
  const parts = Math.max(1, instalments);
  const each = Math.floor(totalCents / parts);
  invariant(Number.isFinite(each), `instalment amount is not a number: ${each}`);
  return Array.from({ length: parts }, (_, i) => (i === 0 ? each + (totalCents - each * parts) : each));
}

export async function priceIn(cents: number, currency: string): Promise<number> {
  const rate = await exchangeRate(currency);
  const converted = Math.round(cents * rate.multiplier);
  invariant(Number.isFinite(converted), `converted price is not a number: ${converted}`);
  return converted;
}
