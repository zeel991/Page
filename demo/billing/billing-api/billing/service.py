"""Invoice arithmetic. Amounts are integer cents throughout."""

from .tax import tax_rate


def subtotal_cents(order):
    return sum(line["unit_price_cents"] * line["quantity"] for line in order["lines"])


def invoice_total_cents(order):
    subtotal = subtotal_cents(order)
    return subtotal + round(subtotal * tax_rate(order["region"]))
