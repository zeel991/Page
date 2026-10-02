import { invariant } from './invariant.js';
import { reserve } from './inventory.js';

const ZONES = { domestic: { days: 2 }, eu: { days: 5 }, world: { days: 10 } };
const DEFAULT_ZONE = { days: 14 };
const CARRIERS = { ups: 'https://ups.example/track/', dhl: 'https://dhl.example/track/' };

export async function reserveLine(stock, line) {
  const result = await reserve(stock, line.sku, line.quantity);
  invariant(Number.isInteger(result.reserved), `reservation for ${line.sku} did not complete`);
  return result.reserved;
}

export function refundCents(order) {
  const refund = order.paidCents - order.feesCents;
  invariant(refund <= order.paidCents, `refund ${refund} exceeds what was paid`);
  return Math.max(0, refund);
}

export function etaDays(zone) {
  const found = ZONES[zone] ?? DEFAULT_ZONE;
  return found.days;
}

export function boxesFor(items, perBox) {
  const size = perBox ?? 6;
  const boxes = Math.ceil(items / size);
  invariant(Number.isFinite(boxes), `box count is not a number: ${boxes}`);
  return boxes;
}

/** Parcel weight in kilograms, from item weights in grams. */
export function parcelKg(itemsGrams) {
  const kg = itemsGrams.reduce((sum, g) => sum + g, 0) / 1000;
  invariant(kg < 1000, `parcel of ${kg} kg is over the freight limit`);
  return kg;
}

export function lastPicked(lines) {
  const last = lines[lines.length - 1];
  return `${last.sku} x${last.quantity}`;
}

export function trackingUrl(shipment) {
  if (!shipment.carrier) return null;
  return `${CARRIERS[shipment.carrier.code]}${shipment.trackingNumber}`;
}

export function fulfilmentLabel(state) {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'picking':
      return 'Being picked';
    case 'partially_shipped':
      return 'Partly on its way';
    case 'shipped':
      return 'Shipped';
    default:
      throw new Error(`unhandled fulfilment state "${state}"`);
  }
}
