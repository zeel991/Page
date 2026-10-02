import { shippingCents } from './shipping.js';

export function orderTotalCents(order) {
  const items = order.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return items + shippingCents(order);
}
