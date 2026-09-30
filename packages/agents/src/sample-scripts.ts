/**
 * Patches supplied to the scripted generator for the seed and for "Send a test
 * incident" — the one scenario a new workspace can run without any integration.
 *
 * These exist to exercise the pipeline around code authorship so the dashboard has
 * a complete incident to show. They are NOT the agent solving anything: every
 * proposal is tagged `scripted` and that tag reaches the PR body and the UI. When a
 * model is configured, this file stops being used.
 */

const PATCHED_CHECKOUT_SERVICE = `import type { OrderRequest } from './types.ts';

export interface Order {
  customerId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  appliedCode: string | null;
}

export class CheckoutService {
  createOrder(request: OrderRequest): Order {
    const subtotalCents = request.items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );

    const code = request.discountCode ?? null;
    const discountCents = code ? Math.round(subtotalCents * (code.percentOff / 100)) : 0;

    return {
      customerId: request.customerId,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      appliedCode: code ? code.value : null,
    };
  }
}
`;

const REGRESSION_TEST = `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';

describe('checkout regression', () => {
  it('creates an order when no discount code is supplied', () => {
    const order = new CheckoutService().createOrder({
      customerId: 'cus_9',
      items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }],
    });
    assert.equal(order.discountCents, 0);
    assert.equal(order.totalCents, 1000);
    assert.equal(order.appliedCode, null);
  });
});
`;

const PATCHED_TAX = `"""Sales tax by region."""

DEFAULT_RATE = 0.0

TAX_RATES = {
    "us-east": 0.07,
    "us-west": 0.0825,
    "eu-central": 0.19,
}


def tax_rate(region):
    """The tax rate for a region, as a fraction of the subtotal."""
    return TAX_RATES.get(region, DEFAULT_RATE)
`;

const TAX_REGRESSION_TEST = `from billing.service import invoice_total_cents


def test_invoices_a_region_with_no_tax_rate_at_the_default_rate():
    order = {"region": "ap-south", "lines": [{"unit_price_cents": 1000, "quantity": 1}]}
    assert invoice_total_cents(order) == 1000
`;

const PATCHED_SHIPPING = `// Shipping fees in cents, by delivery speed.
export const SHIPPING_CENTS = { standard: 499, express: 1299 };

export function shippingCents(order) {
  // Pickup orders have no shipping block and no shipping fee.
  if (!order.shipping) return 0;
  return SHIPPING_CENTS[order.shipping.speed] ?? SHIPPING_CENTS.standard;
}
`;

const SHIPPING_REGRESSION_TEST = `import { expect, it } from 'vitest';
import { orderTotalCents } from '../src/orders.js';

it('totals a pickup order, which has no shipping', () => {
  expect(orderTotalCents({ items: [{ unitPriceCents: 1000, quantity: 2 }] })).toBe(2000);
});
`;

export interface SeedScript {
  regressionTest?: {
    path: string;
    source: string;
    rationale?: string;
    /** Text the runner must really print when this test fails unpatched. */
    expectedFailureMarkers?: string[];
    expectedFailureDescription?: string;
  };
  patch?: {
    rootCause: string;
    explanation: string;
    files: { path: string; content: string }[];
    risks: string[];
    rollbackPlan: string;
    confidence: number;
  };
}

export const SCRIPTS: Record<string, SeedScript> = {
  'INC-001': {
    regressionTest: {
      path: 'test/regression-checkout.test.ts',
      source: REGRESSION_TEST,
      // Text the runner really prints when this fails against the deployed code.
      // Checked against the actual output; a wrong guess here fails the reproduction.
      expectedFailureMarkers: ['TypeError', "reading 'percentOff'"],
      expectedFailureDescription: 'Checkout succeeds when no discount code is supplied.',
    },
    patch: {
      rootCause:
        'createOrder dereferenced request.discountCode without a null check after PR #377 ' +
        'widened the field to optional.',
      explanation: 'Guard the optional discount code instead of dereferencing it.',
      files: [{ path: 'src/checkout/service.ts', content: PATCHED_CHECKOUT_SERVICE }],
      risks: ['Touches a contract shared with the storefront.'],
      rollbackPlan: 'Revert the merge commit. checkout-api holds no migration state.',
      confidence: 0.91,
    },
  },
  // Python: pytest, a KeyError traceback, a pinned requirements file.
  'INC-020': {
    regressionTest: {
      path: 'tests/test_regression_tax_default.py',
      source: TAX_REGRESSION_TEST,
      expectedFailureMarkers: ['KeyError', 'ap-south'],
      expectedFailureDescription: 'An invoice for a region with no listed rate is taxed at the default rate.',
    },
    patch: {
      rootCause: 'tax_rate subscripts TAX_RATES directly since "Look up tax rates strictly", so a region with no rate raises KeyError.',
      explanation: 'Fall back to DEFAULT_RATE for regions without a listed rate, as before the change.',
      files: [{ path: 'billing/tax.py', content: PATCHED_TAX }],
      risks: ['A region that should be taxed but is missing from the table is silently untaxed, as it was before.'],
      rollbackPlan: 'Revert the commit. billing-api holds no migration state.',
      confidence: 0.88,
    },
  },
  // Node with real dependencies: express, supertest and vitest from a lockfile.
  'INC-021': {
    regressionTest: {
      path: 'test/regression-pickup.test.js',
      source: SHIPPING_REGRESSION_TEST,
      expectedFailureMarkers: ['TypeError', "reading 'speed'"],
      expectedFailureDescription: 'A pickup order with no shipping block is totalled without a shipping fee.',
    },
    patch: {
      rootCause: 'shippingCents reads order.shipping.speed, but "Allow pickup orders without shipping" made shipping optional.',
      explanation: 'A pickup order has no shipping block and no shipping fee.',
      files: [{ path: 'src/shipping.js', content: PATCHED_SHIPPING }],
      risks: ['Assumes an order without shipping is a pickup order.'],
      rollbackPlan: 'Revert the commit. orders-api holds no migration state.',
      confidence: 0.87,
    },
  },
};
