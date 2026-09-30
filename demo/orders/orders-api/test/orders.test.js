import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { orderTotalCents } from '../src/orders.js';

describe('orders', () => {
  it('totals items and standard shipping', () => {
    expect(orderTotalCents({ items: [{ unitPriceCents: 1000, quantity: 2 }], shipping: { speed: 'standard' } })).toBe(2499);
  });

  it('charges express shipping', () => {
    expect(orderTotalCents({ items: [{ unitPriceCents: 1000, quantity: 1 }], shipping: { speed: 'express' } })).toBe(2299);
  });

  it('refuses an order with no items', async () => {
    const res = await request(createApp()).post('/orders').send({ items: [], shipping: { speed: 'standard' } });
    expect(res.status).toBe(422);
  });
});
