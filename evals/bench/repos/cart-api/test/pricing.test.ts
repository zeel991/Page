import { it } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotalCents, shippingCents, statusLabel } from '../src/pricing.ts';

it('prices a line by quantity', () => {
  assert.equal(lineTotalCents({ sku: 'A', unitPriceCents: 250, quantity: 4 }), 1000);
});

it('charges the base shipping fee for a parcel under a kilogram', () => {
  assert.equal(shippingCents(0), 299);
});

it('labels a paid order', () => {
  assert.equal(statusLabel('paid'), 'Paid');
});
