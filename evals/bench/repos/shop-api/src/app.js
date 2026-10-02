import express from 'express';
import { boxesFor, etaDays, fulfilmentLabel, lastPicked, parcelKg, refundCents, reserveLine, trackingUrl } from './fulfilment.js';

export function createApp(stock = {}) {
  const app = express();
  app.use(express.json());
  app.post('/fulfil', async (req, res) => {
    const order = req.body;
    const reserved = [];
    for (const line of order.lines) reserved.push(await reserveLine(stock, line));
    res.json({
      reserved,
      boxes: boxesFor(order.lines.length, order.perBox),
      kg: parcelKg(order.itemsGrams ?? []),
      eta: etaDays(order.zone),
      last: lastPicked(order.lines),
      tracking: trackingUrl(order.shipment ?? {}),
      state: fulfilmentLabel(order.state ?? 'queued'),
    });
  });
  app.post('/refund', (req, res) => res.json({ refund: refundCents(req.body) }));
  return app;
}
