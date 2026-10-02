import { discountCents, instalmentCents, priceIn, shippingCents, statusLabel, subtotalCents, taxCents, type Discount, type Line, type OrderStatus } from './pricing.ts';

export interface CheckoutRequest {
  lines: Line[];
  region: string;
  weightGrams: number;
  discount?: Discount;
  currency?: string;
  instalments?: number;
  status?: OrderStatus;
}

export async function quote(request: CheckoutRequest) {
  const subtotal = subtotalCents(request.lines);
  const discount = discountCents(subtotal, request.discount);
  const tax = taxCents(subtotal - discount, request.region);
  const shipping = shippingCents(request.weightGrams);
  const total = subtotal - discount + tax + shipping;
  return {
    subtotal,
    discount,
    tax,
    shipping,
    total,
    display: await priceIn(total, request.currency ?? 'USD'),
    instalments: instalmentCents(total, request.instalments ?? 1),
    status: statusLabel(request.status ?? 'pending'),
  };
}
