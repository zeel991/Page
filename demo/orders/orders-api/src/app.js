import express from 'express';
import { orderTotalCents } from './orders.js';
import { validateOrder } from './validate.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.post('/orders', (req, res) => {
    const problems = validateOrder(req.body);
    if (problems.length > 0) return res.status(422).json({ problems });
    return res.status(201).json({ totalCents: orderTotalCents(req.body) });
  });
  return app;
}
