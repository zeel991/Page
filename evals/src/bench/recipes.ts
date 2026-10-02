/**
 * The benchmark's bug recipes and negative controls.
 *
 * A recipe is a small, named change to one of the clean base repositories under
 * `evals/bench/repos` — the bug the deployment ships — plus how to trigger it, a
 * hidden oracle test that decides whether a fix really works, and the regression
 * test and patch a scripted author proposes. Telemetry is not written here: the
 * generator runs the buggy code with the trigger and records what it actually
 * throws, with the stack it actually has.
 *
 * The oracle lives only here. It is never placed in the fixture, the repository or
 * any prompt, so a model cannot read the answer it is scored against.
 */

export type RepoId = 'cart-api' | 'shop-api' | 'invoice-api';

export type BugType =
  | 'null_access'
  | 'wrong_default'
  | 'off_by_one'
  | 'missing_await'
  | 'unhandled_enum'
  | 'wrong_unit'
  | 'missing_fallback'
  | 'division_by_zero'
  | 'wrong_operator';

export type ControlType = 'error_predates_deploy' | 'stale_telemetry' | 'downstream_503' | 'flaky_test';

export interface RepoSpec {
  id: RepoId;
  /** The repository the twin serves, and the service name telemetry is tagged with. */
  repository: string;
  service: string;
  language: 'typescript' | 'javascript' | 'python';
  /** Where the service runs in production; stack paths are rewritten to it. */
  deployRoot: string;
  /** Imported by the trigger: the module whose function the payload calls. */
  entry: string;
  route: string;
}

export const REPOS: Record<RepoId, RepoSpec> = {
  'cart-api': { id: 'cart-api', repository: 'acme/cart-api', service: 'cart-api', language: 'typescript', deployRoot: '/app', entry: 'src/checkout.ts', route: 'POST /quote' },
  'shop-api': { id: 'shop-api', repository: 'acme/shop-api', service: 'shop-api', language: 'javascript', deployRoot: '/app', entry: 'src/fulfilment.js', route: 'POST /fulfil' },
  'invoice-api': { id: 'invoice-api', repository: 'acme/invoice-api', service: 'invoice-api', language: 'python', deployRoot: '/srv/app', entry: 'billing/api.py', route: 'POST /invoices/summary' },
};

export interface TestFile {
  path: string;
  source: string;
}

export interface BugRecipe {
  id: string;
  repo: RepoId;
  type: BugType;
  /** The file the deployment changed, and exactly how. */
  file: string;
  find: string;
  replace: string;
  commit: string;
  /**
   * An expression that makes the failure happen, evaluated with the entry module in
   * scope as `m` (JavaScript, awaited) or with `summarize` imported (Python).
   */
  trigger: string;
  /** Hidden. Fails against the bug, passes against the fix. */
  oracle: TestFile;
  /** What the scripted author writes as its regression test. */
  test: TestFile & { markers: string[]; description: string };
}

export interface ControlRecipe {
  id: string;
  repo: RepoId;
  type: ControlType;
  why: string;
  /** For error_predates_deploy and stale_telemetry: the real bug behind the errors. */
  bug?: string;
  /** For downstream_503 and flaky_test: the errors production shows, as a runtime would log them. */
  telemetry?: { message: string; stack: string; errorType: string };
  /** What an eager scripted author would propose anyway. */
  author: { test: TestFile & { markers: string[]; description: string }; patch: { path: string; content: string } | null };
}

// ── cart-api (TypeScript, node:test) ───────────────────────────────────────────

const cartTest = (name: string, body: string, imports = 'lineTotalCents'): string =>
  `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${imports} } from '../src/pricing.ts';\n\nit(${JSON.stringify(name)}, async () => {\n  ${body}\n});\n`;

const cartQuote = (over: string) =>
  `m.quote({ lines: [{ sku: 'A', unitPriceCents: 1500, quantity: 2 }], region: 'us-east', weightGrams: 800${over} })`;

// ── shop-api (JavaScript, vitest) ──────────────────────────────────────────────

const shopTest = (name: string, body: string, imports: string): string =>
  `import { expect, it } from 'vitest';\nimport { ${imports} } from '../src/fulfilment.js';\n\nit(${JSON.stringify(name)}, async () => {\n  ${body}\n});\n`;

// ── invoice-api (Python, pytest) ───────────────────────────────────────────────

const invTest = (name: string, body: string, imports: string): string =>
  `from billing.invoice import ${imports}\n\n\ndef ${name}():\n    ${body}\n`;

const invoice = (over: string) =>
  `{"region": "us-east", "lines": [{"sku": "A", "unit_price_cents": 1500, "quantity": 2}], "payments": [1200, 1800]${over}}`;

export const BUGS: BugRecipe[] = [
  // cart-api
  {
    id: 'cart-wrong-default', repo: 'cart-api', type: 'wrong_default', file: 'src/pricing.ts',
    find: '(line.quantity ?? 1)', replace: '(line.quantity ?? 0)',
    commit: 'Stop assuming a quantity of one',
    trigger: `m.quote({ lines: [{ sku: 'A', unitPriceCents: 1500 }], region: 'us-east', weightGrams: 800 })`,
    oracle: { path: 'test/oracle-line-default.test.ts', source: cartTest('prices a line without a quantity as one unit', 'assert.equal(lineTotalCents({ sku: "A", unitPriceCents: 500 }), 500);') },
    test: { path: 'test/regression-quantity.test.ts', source: cartTest('a line with no quantity counts once', 'assert.equal(lineTotalCents({ sku: "B", unitPriceCents: 200 }), 200);'), markers: ['InvariantError'], description: 'A line with no quantity is priced as one unit.' },
  },
  {
    id: 'cart-off-by-one', repo: 'cart-api', type: 'off_by_one', file: 'src/pricing.ts',
    find: 'i < lines.length; i++', replace: 'i <= lines.length; i++',
    commit: 'Iterate lines with an index',
    trigger: cartQuote(''),
    oracle: { path: 'test/oracle-subtotal.test.ts', source: cartTest('sums every line exactly once', 'assert.equal(subtotalCents([{ sku: "A", unitPriceCents: 100, quantity: 2 }, { sku: "B", unitPriceCents: 50 }]), 250);', 'subtotalCents') },
    test: { path: 'test/regression-subtotal.test.ts', source: cartTest('subtotals a single line', 'assert.equal(subtotalCents([{ sku: "C", unitPriceCents: 300, quantity: 1 }]), 300);', 'subtotalCents'), markers: ['TypeError', 'unitPriceCents'], description: 'The subtotal reads exactly the lines there are.' },
  },
  {
    id: 'cart-null-discount', repo: 'cart-api', type: 'null_access', file: 'src/pricing.ts',
    find: '  if (!discount) return 0;\n', replace: '',
    commit: 'Tidy discount calculation',
    trigger: cartQuote(''),
    oracle: { path: 'test/oracle-no-discount.test.ts', source: cartTest('no discount means nothing off', 'assert.equal(discountCents(1000), 0);', 'discountCents') },
    test: { path: 'test/regression-discount.test.ts', source: cartTest('an order without a discount code gets none', 'assert.equal(discountCents(500, undefined), 0);', 'discountCents'), markers: ['TypeError', 'percentOff'], description: 'An order without a discount code is not discounted.' },
  },
  {
    id: 'cart-missing-fallback', repo: 'cart-api', type: 'missing_fallback', file: 'src/pricing.ts',
    find: 'TAX_RATES[region] ?? DEFAULT_TAX', replace: 'TAX_RATES[region]',
    commit: 'Look tax rates up strictly',
    trigger: `m.quote({ lines: [{ sku: 'A', unitPriceCents: 1500, quantity: 2 }], region: 'ap-south', weightGrams: 800 })`,
    oracle: { path: 'test/oracle-tax-default.test.ts', source: cartTest('an unlisted region is taxed at the default rate', 'assert.equal(taxCents(1000, "ap-south"), 0);', 'taxCents') },
    test: { path: 'test/regression-tax.test.ts', source: cartTest('taxes an unlisted region at the default', 'assert.equal(taxCents(500, "sa-east"), 0);', 'taxCents'), markers: ['TypeError', 'percent'], description: 'A region with no listed rate is taxed at the default rate.' },
  },
  {
    id: 'cart-wrong-unit', repo: 'cart-api', type: 'wrong_unit', file: 'src/pricing.ts',
    find: 'weightGrams / 1000', replace: 'weightGrams / 10',
    commit: 'Charge shipping by weight band',
    trigger: `m.quote({ lines: [{ sku: 'A', unitPriceCents: 1500, quantity: 2 }], region: 'us-east', weightGrams: 5000 })`,
    oracle: { path: 'test/oracle-shipping.test.ts', source: cartTest('charges a dollar per started kilogram', 'assert.equal(shippingCents(2500), 599);', 'shippingCents') },
    test: { path: 'test/regression-shipping.test.ts', source: cartTest('prices a 1.5 kg parcel', 'assert.equal(shippingCents(1500), 499);', 'shippingCents'), markers: ['InvariantError', 'exceeds the cap'], description: 'Shipping is charged per kilogram, not per ten grams.' },
  },
  {
    id: 'cart-unhandled-enum', repo: 'cart-api', type: 'unhandled_enum', file: 'src/pricing.ts',
    find: "    case 'refunded':\n      return 'Refunded';\n", replace: '',
    commit: 'Simplify order status labels',
    trigger: cartQuote(", status: 'refunded'"),
    oracle: { path: 'test/oracle-refunded.test.ts', source: cartTest('labels a refunded order', 'assert.equal(statusLabel("refunded"), "Refunded");', 'statusLabel') },
    test: { path: 'test/regression-status.test.ts', source: cartTest('has a label for refunds', 'assert.equal(statusLabel("refunded"), "Refunded");', 'statusLabel'), markers: ['unhandled order status'], description: 'Every order status has a label, refunds included.' },
  },
  {
    id: 'cart-divide-by-zero', repo: 'cart-api', type: 'division_by_zero', file: 'src/pricing.ts',
    find: 'const parts = Math.max(1, instalments);', replace: 'const parts = instalments;',
    commit: 'Honour the requested instalment count',
    trigger: cartQuote(', instalments: 0'),
    oracle: { path: 'test/oracle-instalments.test.ts', source: cartTest('treats zero instalments as paying in full', 'assert.deepEqual(instalmentCents(1000, 0), [1000]);', 'instalmentCents') },
    test: { path: 'test/regression-instalments.test.ts', source: cartTest('pays in one go when no instalments are asked for', 'assert.deepEqual(instalmentCents(500, 0), [500]);', 'instalmentCents'), markers: ['InvariantError', 'not a number'], description: 'Zero instalments means one payment, not a division by zero.' },
  },
  {
    id: 'cart-missing-await', repo: 'cart-api', type: 'missing_await', file: 'src/pricing.ts',
    find: 'const rate = await exchangeRate(currency);', replace: 'const rate = exchangeRate(currency);',
    commit: 'Type the exchange rate lookup',
    trigger: cartQuote(", currency: 'EUR'"),
    oracle: { path: 'test/oracle-currency.test.ts', source: cartTest('converts to euros', 'assert.equal(await priceIn(1000, "EUR"), 920);', 'priceIn') },
    test: { path: 'test/regression-currency.test.ts', source: cartTest('converts dollars to dollars', 'assert.equal(await priceIn(100, "USD"), 100);', 'priceIn'), markers: ['InvariantError', 'not a number'], description: 'A converted price is computed from the rate, not from a pending promise.' },
  },

  // shop-api
  {
    id: 'shop-missing-await', repo: 'shop-api', type: 'missing_await', file: 'src/fulfilment.js',
    find: 'const result = await reserve(', replace: 'const result = reserve(',
    commit: 'Reserve stock without blocking the request',
    trigger: `m.reserveLine({ A: 5 }, { sku: 'A', quantity: 2 })`,
    oracle: { path: 'test/oracle-reserve.test.js', source: shopTest('reserves what is asked for', 'expect(await reserveLine({ A: 5 }, { sku: "A", quantity: 2 })).toBe(2);', 'reserveLine') },
    test: { path: 'test/regression-reserve.test.js', source: shopTest('reserves a single unit', 'expect(await reserveLine({ B: 1 }, { sku: "B", quantity: 1 })).toBe(1);', 'reserveLine'), markers: ['InvariantError', 'did not complete'], description: 'A reservation waits for the stock service before reporting what it reserved.' },
  },
  {
    id: 'shop-wrong-operator', repo: 'shop-api', type: 'wrong_operator', file: 'src/fulfilment.js',
    find: 'order.paidCents - order.feesCents', replace: 'order.paidCents + order.feesCents',
    commit: 'Include fees in refund calculation',
    trigger: `m.refundCents({ paidCents: 1000, feesCents: 100 })`,
    oracle: { path: 'test/oracle-refund.test.js', source: shopTest('refunds what was paid less fees', 'expect(refundCents({ paidCents: 1000, feesCents: 100 })).toBe(900);', 'refundCents') },
    test: { path: 'test/regression-refund.test.js', source: shopTest('keeps the fees out of a refund', 'expect(refundCents({ paidCents: 500, feesCents: 50 })).toBe(450);', 'refundCents'), markers: ['InvariantError', 'exceeds what was paid'], description: 'A refund is what was paid less fees.' },
  },
  {
    id: 'shop-missing-fallback', repo: 'shop-api', type: 'missing_fallback', file: 'src/fulfilment.js',
    find: 'ZONES[zone] ?? DEFAULT_ZONE', replace: 'ZONES[zone]',
    commit: 'Look delivery zones up directly',
    trigger: `m.etaDays('mars')`,
    oracle: { path: 'test/oracle-zone.test.js', source: shopTest('estimates an unknown zone at the default', 'expect(etaDays("mars")).toBe(14);', 'etaDays') },
    test: { path: 'test/regression-zone.test.js', source: shopTest('has an estimate for an unlisted zone', 'expect(etaDays("antarctica")).toBe(14);', 'etaDays'), markers: ['TypeError', 'days'], description: 'An unlisted delivery zone gets the default estimate.' },
  },
  {
    id: 'shop-wrong-default', repo: 'shop-api', type: 'wrong_default', file: 'src/fulfilment.js',
    find: 'perBox ?? 6', replace: 'perBox ?? 0',
    commit: 'Make box size explicit',
    trigger: `m.boxesFor(7)`,
    oracle: { path: 'test/oracle-boxes.test.js', source: shopTest('packs seven items into two boxes of six', 'expect(boxesFor(7)).toBe(2);', 'boxesFor') },
    test: { path: 'test/regression-boxes.test.js', source: shopTest('packs one item into one box', 'expect(boxesFor(1)).toBe(1);', 'boxesFor'), markers: ['InvariantError', 'not a number'], description: 'Box size defaults to six.' },
  },
  {
    id: 'shop-wrong-unit', repo: 'shop-api', type: 'wrong_unit', file: 'src/fulfilment.js',
    find: 'sum + g, 0) / 1000', replace: 'sum + g, 0) / 1',
    commit: 'Report parcel weight directly',
    trigger: `m.parcelKg([500, 1500])`,
    oracle: { path: 'test/oracle-weight.test.js', source: shopTest('weighs a parcel in kilograms', 'expect(parcelKg([500, 1500])).toBe(2);', 'parcelKg') },
    test: { path: 'test/regression-weight.test.js', source: shopTest('a kilogram weighs one', 'expect(parcelKg([1000])).toBe(1);', 'parcelKg'), markers: ['InvariantError', 'freight limit'], description: 'Parcel weight is reported in kilograms, from grams.' },
  },
  {
    id: 'shop-off-by-one', repo: 'shop-api', type: 'off_by_one', file: 'src/fulfilment.js',
    find: 'lines[lines.length - 1]', replace: 'lines[lines.length]',
    commit: 'Show the most recent pick',
    trigger: `m.lastPicked([{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 2 }])`,
    oracle: { path: 'test/oracle-last-pick.test.js', source: shopTest('shows the last line picked', 'expect(lastPicked([{ sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }])).toBe("B x2");', 'lastPicked') },
    test: { path: 'test/regression-last-pick.test.js', source: shopTest('shows a single pick', 'expect(lastPicked([{ sku: "C", quantity: 3 }])).toBe("C x3");', 'lastPicked'), markers: ['TypeError', 'sku'], description: 'The last pick is the last line, not one past it.' },
  },
  {
    id: 'shop-null-carrier', repo: 'shop-api', type: 'null_access', file: 'src/fulfilment.js',
    find: '  if (!shipment.carrier) return null;\n', replace: '',
    commit: 'Build tracking links for every shipment',
    trigger: `m.trackingUrl({ trackingNumber: 'T1' })`,
    oracle: { path: 'test/oracle-tracking.test.js', source: shopTest('has no tracking link without a carrier', 'expect(trackingUrl({ trackingNumber: "1" })).toBeNull();', 'trackingUrl') },
    test: { path: 'test/regression-tracking.test.js', source: shopTest('skips tracking for a collection', 'expect(trackingUrl({ trackingNumber: "X" })).toBeNull();', 'trackingUrl'), markers: ['TypeError', 'code'], description: 'A shipment with no carrier has no tracking link.' },
  },
  {
    id: 'shop-unhandled-enum', repo: 'shop-api', type: 'unhandled_enum', file: 'src/fulfilment.js',
    find: "    case 'partially_shipped':\n      return 'Partly on its way';\n", replace: '',
    commit: 'Collapse fulfilment states',
    trigger: `m.fulfilmentLabel('partially_shipped')`,
    oracle: { path: 'test/oracle-partial.test.js', source: shopTest('labels a partial shipment', 'expect(fulfilmentLabel("partially_shipped")).toBe("Partly on its way");', 'fulfilmentLabel') },
    test: { path: 'test/regression-partial.test.js', source: shopTest('has a label for partial shipments', 'expect(fulfilmentLabel("partially_shipped")).toBe("Partly on its way");', 'fulfilmentLabel'), markers: ['unhandled fulfilment state'], description: 'Every fulfilment state has a label.' },
  },

  // invoice-api
  {
    id: 'inv-wrong-default', repo: 'invoice-api', type: 'wrong_default', file: 'billing/invoice.py',
    find: 'line.get("quantity", 1)', replace: 'line.get("quantity", 0)',
    commit: 'Stop defaulting line quantities',
    trigger: `{"region": "us-east", "lines": [{"sku": "A", "unit_price_cents": 1500}]}`,
    oracle: { path: 'tests/test_oracle_line_default.py', source: invTest('test_line_without_quantity_is_one_unit', 'assert line_total({"sku": "A", "unit_price_cents": 500}) == 500', 'line_total') },
    test: { path: 'tests/test_regression_quantity.py', source: invTest('test_missing_quantity_counts_once', 'assert line_total({"sku": "B", "unit_price_cents": 200}) == 200', 'line_total'), markers: ['InvariantError'], description: 'A line with no quantity is billed as one unit.' },
  },
  {
    id: 'inv-missing-fallback', repo: 'invoice-api', type: 'missing_fallback', file: 'billing/invoice.py',
    find: 'TAX_RATES.get(region, DEFAULT_TAX)', replace: 'TAX_RATES[region]',
    commit: 'Look tax rates up strictly',
    trigger: invoice(', "region": "ap-south"'),
    oracle: { path: 'tests/test_oracle_tax_default.py', source: invTest('test_unlisted_region_is_default_rate', 'assert tax_rate("ap-south") == 0.0', 'tax_rate') },
    test: { path: 'tests/test_regression_tax.py', source: invTest('test_unlisted_region_taxed_at_default', 'assert tax_rate("sa-east") == 0.0', 'tax_rate'), markers: ['KeyError'], description: 'A region with no listed rate is taxed at the default rate.' },
  },
  {
    id: 'inv-zero-division', repo: 'invoice-api', type: 'division_by_zero', file: 'billing/invoice.py',
    find: '    if days_in_period <= 0:\n        return amount_cents\n', replace: '',
    commit: 'Simplify proration',
    trigger: invoice(', "days_in_period": 0'),
    oracle: { path: 'tests/test_oracle_prorate.py', source: invTest('test_empty_period_is_not_prorated', 'assert prorate(3000, 10, 0) == 3000', 'prorate') },
    test: { path: 'tests/test_regression_prorate.py', source: invTest('test_zero_day_period_bills_in_full', 'assert prorate(100, 5, 0) == 100', 'prorate'), markers: ['ZeroDivisionError'], description: 'A billing period of no days is billed in full.' },
  },
  {
    id: 'inv-unhandled-enum', repo: 'invoice-api', type: 'unhandled_enum', file: 'billing/invoice.py',
    find: '    elif terms == "due_on_receipt":\n        return 0\n', replace: '',
    commit: 'Trim payment terms',
    trigger: invoice(', "terms": "due_on_receipt"'),
    oracle: { path: 'tests/test_oracle_terms.py', source: invTest('test_due_on_receipt_is_zero_days', 'assert terms_days("due_on_receipt") == 0', 'terms_days') },
    test: { path: 'tests/test_regression_terms.py', source: invTest('test_receipt_terms_are_known', 'assert terms_days("due_on_receipt") == 0', 'terms_days'), markers: ['unknown payment terms'], description: 'Every payment term is known, due-on-receipt included.' },
  },
  {
    id: 'inv-wrong-unit', repo: 'invoice-api', type: 'wrong_unit', file: 'billing/invoice.py',
    find: 'LATE_FEE_PER_DAY = 0.0005', replace: 'LATE_FEE_PER_DAY = 0.05',
    commit: 'Express the late fee as a daily rate',
    trigger: invoice(', "days_late": 30'),
    oracle: { path: 'tests/test_oracle_late_fee.py', source: invTest('test_late_fee_is_a_twentieth_of_a_percent_a_day', 'assert late_fee(10000, 10) == 50', 'late_fee') },
    test: { path: 'tests/test_regression_late_fee.py', source: invTest('test_late_fee_for_a_month', 'assert late_fee(20000, 30) == 300', 'late_fee'), markers: ['InvariantError', 'exceeds the balance'], description: 'The late fee is a small fraction of the balance per day.' },
  },
  {
    id: 'inv-off-by-one', repo: 'invoice-api', type: 'off_by_one', file: 'billing/invoice.py',
    find: 'return payments[-1]', replace: 'return payments[len(payments)]',
    commit: 'Index payments explicitly',
    trigger: invoice(''),
    oracle: { path: 'tests/test_oracle_last_payment.py', source: invTest('test_last_payment_is_the_latest', 'assert last_payment([1, 2]) == 2', 'last_payment') },
    test: { path: 'tests/test_regression_last_payment.py', source: invTest('test_single_payment_is_the_last', 'assert last_payment([5]) == 5', 'last_payment'), markers: ['IndexError'], description: 'The last payment is the latest one, not one past it.' },
  },
  {
    id: 'inv-none-access', repo: 'invoice-api', type: 'null_access', file: 'billing/invoice.py',
    find: 'customer = invoice.get("customer") or {}', replace: 'customer = invoice.get("customer")',
    commit: 'Read the customer record directly',
    trigger: invoice(', "customer": None'),
    oracle: { path: 'tests/test_oracle_email.py', source: invTest('test_no_customer_means_no_email', 'assert customer_email({"customer": None}) is None', 'customer_email') },
    test: { path: 'tests/test_regression_email.py', source: invTest('test_missing_customer_has_no_email', 'assert customer_email({}) is None', 'customer_email'), markers: ['AttributeError', 'NoneType'], description: 'An invoice without a customer has no email address.' },
  },
  {
    id: 'inv-wrong-operator', repo: 'invoice-api', type: 'wrong_operator', file: 'billing/invoice.py',
    find: 'max(0, balance_cents - credit_cents)', replace: 'max(0, balance_cents + credit_cents)',
    commit: 'Apply credit notes',
    trigger: invoice(', "credit_cents": 300'),
    oracle: { path: 'tests/test_oracle_credit.py', source: invTest('test_credit_reduces_the_balance', 'assert apply_credit(1000, 300) == 700', 'apply_credit') },
    test: { path: 'tests/test_regression_credit.py', source: invTest('test_credit_is_subtracted', 'assert apply_credit(500, 100) == 400', 'apply_credit'), markers: ['InvariantError', 'credit increased'], description: 'A credit reduces the balance.' },
  },
];

const FLAKY_JS = `import { expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { reserveLine } from '../src/fulfilment.js';

// The eager author's reproduction of a timeout: it fails the first time it runs in
// a checkout and passes after, like a real timing-dependent test.
it('reserves stock within the time limit', async () => {
  const warm = existsSync('.warm');
  writeFileSync('.warm', '');
  if (!warm) throw new Error('TimeoutError: inventory lookup timed out after 2000ms');
  expect(await reserveLine({ A: 1 }, { sku: 'A', quantity: 1 })).toBe(1);
});
`;

const FLAKY_PY = `import os

from billing.invoice import line_total


def test_totals_within_the_time_limit():
    warm = os.path.exists(".warm")
    open(".warm", "w").close()
    if not warm:
        raise TimeoutError("ledger lookup timed out after 2s")
    assert line_total({"sku": "A", "unit_price_cents": 100}) == 100
`;

export const CONTROLS: ControlRecipe[] = [
  {
    id: 'ctl-predates-cart', repo: 'cart-api', type: 'error_predates_deploy', bug: 'cart-missing-fallback',
    why: 'The same TypeError was already happening an hour before the deploy, which changed only the README. The deploy did not cause it.',
    author: { test: BUGS.find((b) => b.id === 'cart-missing-fallback')!.test, patch: null },
  },
  {
    id: 'ctl-predates-shop', repo: 'shop-api', type: 'error_predates_deploy', bug: 'shop-null-carrier',
    why: 'Tracking links have been failing since before the deploy, which changed only the README.',
    author: { test: BUGS.find((b) => b.id === 'shop-null-carrier')!.test, patch: null },
  },
  {
    id: 'ctl-predates-invoice', repo: 'invoice-api', type: 'error_predates_deploy', bug: 'inv-missing-fallback',
    why: 'The KeyError predates the deploy, which changed only the README.',
    author: { test: BUGS.find((b) => b.id === 'inv-missing-fallback')!.test, patch: null },
  },
  {
    id: 'ctl-stale-cart', repo: 'cart-api', type: 'stale_telemetry', bug: 'cart-null-discount',
    why: 'The errors stopped four hours ago and the monitor never cleared. Nothing is failing now.',
    author: { test: BUGS.find((b) => b.id === 'cart-null-discount')!.test, patch: null },
  },
  {
    id: 'ctl-stale-invoice', repo: 'invoice-api', type: 'stale_telemetry', bug: 'inv-zero-division',
    why: 'The errors are four hours old; the evidence window does not reach them.',
    author: { test: BUGS.find((b) => b.id === 'inv-zero-division')!.test, patch: null },
  },
  {
    id: 'ctl-downstream-cart', repo: 'cart-api', type: 'downstream_503',
    why: 'The payments service is answering 503. Every frame is inside its client library; the deploy changed only the README.',
    telemetry: {
      errorType: 'UpstreamError',
      message: 'UpstreamError: payments service responded 503 Service Unavailable',
      stack:
        'UpstreamError: payments service responded 503 Service Unavailable\n' +
        '    at PaymentsClient.request (/app/node_modules/@acme/payments-client/dist/index.js:188:13)\n' +
        '    at async PaymentsClient.authorize (/app/node_modules/@acme/payments-client/dist/index.js:92:20)\n' +
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    },
    author: {
      test: {
        path: 'test/regression-payments.test.ts',
        source: cartTest('quotes an order', 'const q = await quote({ lines: [{ sku: "A", unitPriceCents: 1000, quantity: 1 }], region: "us-east", weightGrams: 0 }); assert.equal(q.subtotal, 1000);', 'lineTotalCents').replace("import { lineTotalCents } from '../src/pricing.ts';", "import { quote } from '../src/checkout.ts';"),
        markers: ['UpstreamError'],
        description: 'Checkout survives a payments outage.',
      },
      patch: null,
    },
  },
  {
    id: 'ctl-downstream-invoice', repo: 'invoice-api', type: 'downstream_503',
    why: 'The ledger service is answering 503 inside the HTTP client; the deploy changed only the README.',
    telemetry: {
      errorType: 'HTTPError',
      message: 'ledger sync failed',
      stack:
        'Traceback (most recent call last):\n' +
        '  File "/usr/local/lib/python3.12/site-packages/requests/models.py", line 1024, in raise_for_status\n' +
        '    raise HTTPError(http_error_msg, response=self)\n' +
        'requests.exceptions.HTTPError: 503 Server Error: Service Unavailable for url: https://ledger.internal/sync',
    },
    author: {
      test: {
        path: 'tests/test_regression_ledger.py',
        source: `from billing.api import summarize\n\n\ndef test_summarizes_during_an_outage():\n    assert summarize(${invoice('')})["subtotal"] == 3000\n`,
        markers: ['HTTPError'],
        description: 'Invoices summarize during a ledger outage.',
      },
      patch: null,
    },
  },
  {
    id: 'ctl-flaky-shop', repo: 'shop-api', type: 'flaky_test',
    why: 'An intermittent timeout from the stock service. Nothing in the code is wrong; a test written for it passes or fails depending on timing.',
    telemetry: {
      errorType: 'TimeoutError',
      message: 'TimeoutError: inventory lookup timed out after 2000ms',
      stack:
        'TimeoutError: inventory lookup timed out after 2000ms\n' +
        '    at reserve (file:///app/src/inventory.js:3:21)\n' +
        '    at reserveLine (file:///app/src/fulfilment.js:9:24)\n' +
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    },
    author: {
      test: { path: 'test/regression-timeout.test.js', source: FLAKY_JS, markers: ['TimeoutError'], description: 'Stock is reserved within the time limit.' },
      patch: { path: 'src/inventory.js', content: '// The stock service, called asynchronously as a real one would be.\n// Retried once on a timeout.\nexport async function reserve(stock, sku, quantity) {\n  const available = stock[sku] ?? 0;\n  const reserved = Math.min(available, quantity);\n  stock[sku] = available - reserved;\n  return { sku, reserved };\n}\n' },
    },
  },
  {
    id: 'ctl-flaky-invoice', repo: 'invoice-api', type: 'flaky_test',
    why: 'An intermittent ledger timeout. A test written for it passes on the second run whatever the code does.',
    telemetry: {
      errorType: 'TimeoutError',
      message: 'invoice summary failed',
      stack:
        'Traceback (most recent call last):\n' +
        '  File "/srv/app/billing/api.py", line 9, in summarize\n' +
        '    subtotal = sum(line_total(line) for line in invoice["lines"])\n' +
        'TimeoutError: ledger lookup timed out after 2s',
    },
    author: {
      test: { path: 'tests/test_regression_timeout.py', source: FLAKY_PY, markers: ['TimeoutError'], description: 'Invoices total within the time limit.' },
      patch: { path: 'billing/errors.py', content: 'class InvariantError(Exception):\n    """A value the service computed is impossible; the request fails rather than bill it."""\n\n\n# Retried once on a timeout.\ndef invariant(condition, message):\n    if not condition:\n        raise InvariantError(message)\n' },
    },
  },
];

/** The deterministic subset CI runs: one bug per repository and one control of each kind. */
export const CI_SUBSET = ['cart-null-discount', 'shop-missing-await', 'inv-missing-fallback', 'ctl-predates-cart', 'ctl-stale-invoice', 'ctl-downstream-cart', 'ctl-flaky-shop'];
