/** Exchange rates, looked up asynchronously as a real rate service would be. */
const MULTIPLIERS: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79 };

export async function exchangeRate(currency: string): Promise<{ currency: string; multiplier: number }> {
  const multiplier = MULTIPLIERS[currency];
  if (multiplier === undefined) throw new Error(`no exchange rate for ${currency}`);
  return { currency, multiplier };
}
