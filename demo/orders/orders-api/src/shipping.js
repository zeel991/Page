// Shipping fees in cents, by delivery speed.
export const SHIPPING_CENTS = { standard: 499, express: 1299 };

export function shippingCents(order) {
  return SHIPPING_CENTS[order.shipping.speed] ?? SHIPPING_CENTS.standard;
}
