// The stock service, called asynchronously as a real one would be.
export async function reserve(stock, sku, quantity) {
  const available = stock[sku] ?? 0;
  const reserved = Math.min(available, quantity);
  stock[sku] = available - reserved;
  return { sku, reserved };
}
