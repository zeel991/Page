"""Invoice arithmetic. Amounts are integer cents throughout."""

from datetime import date, timedelta

from .errors import invariant

DEFAULT_TAX = 0.0
TAX_RATES = {"us-east": 0.07, "us-west": 0.0825, "eu-central": 0.19}
LATE_FEE_PER_DAY = 0.0005  # a fraction of the balance, per day


def line_total(line):
    total = line["unit_price_cents"] * line.get("quantity", 1)
    invariant(total > 0, "line total for %s must be positive, got %s" % (line["sku"], total))
    return total


def tax_rate(region):
    return TAX_RATES.get(region, DEFAULT_TAX)


def prorate(amount_cents, days_used, days_in_period):
    if days_in_period <= 0:
        return amount_cents
    return round(amount_cents * days_used / days_in_period)


def terms_days(terms):
    if terms == "net15":
        return 15
    elif terms == "net30":
        return 30
    elif terms == "net60":
        return 60
    elif terms == "due_on_receipt":
        return 0
    raise ValueError("unknown payment terms %r" % (terms,))


def due_date(issued, terms):
    return issued + timedelta(days=terms_days(terms))


def late_fee(balance_cents, days_late):
    fee = round(balance_cents * LATE_FEE_PER_DAY * days_late)
    invariant(fee <= balance_cents, "late fee %s exceeds the balance %s" % (fee, balance_cents))
    return fee


def last_payment(payments):
    return payments[-1]


def customer_email(invoice):
    customer = invoice.get("customer") or {}
    return customer.get("email")


def apply_credit(balance_cents, credit_cents):
    remaining = max(0, balance_cents - credit_cents)
    invariant(remaining <= balance_cents, "credit increased the balance to %s" % (remaining,))
    return remaining
