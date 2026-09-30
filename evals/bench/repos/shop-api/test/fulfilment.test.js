import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { etaDays, fulfilmentLabel } from '../src/fulfilment.js';

describe('fulfilment', () => {
  it('knows domestic delivery takes two days', () => {
    expect(etaDays('domestic')).toBe(2);
  });

  it('labels a queued order', () => {
    expect(fulfilmentLabel('queued')).toBe('Queued');
  });

  it('serves the refund route', async () => {
    const res = await request(createApp()).post('/refund').send({ paidCents: 1000, feesCents: 0 });
    expect(res.status).toBe(200);
  });
});
