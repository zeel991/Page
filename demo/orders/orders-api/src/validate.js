// Request validation. Returns a list of problems; empty means valid.
export function validateOrder(body) {
  const problems = [];
  if (!body || typeof body !== 'object') return ['body must be a JSON object'];
  if (!Array.isArray(body.items) || body.items.length === 0) problems.push('items must be a non-empty array');
  // Shipping is optional: pickup orders have none.
  if (body.shipping !== undefined && typeof body.shipping.speed !== 'string') problems.push('shipping.speed must be a string');
  return problems;
}
