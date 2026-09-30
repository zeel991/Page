"""Request handlers: an invoice payload in, a summary out."""

from datetime import date

from .invoice import apply_credit, customer_email, due_date, last_payment, late_fee, line_total, prorate, tax_rate


def summarize(invoice):
    subtotal = sum(line_total(line) for line in invoice["lines"])
    subtotal = prorate(subtotal, invoice.get("days_used", 30), invoice.get("days_in_period", 30))
    tax = round(subtotal * tax_rate(invoice["region"]))
    balance = apply_credit(subtotal + tax, invoice.get("credit_cents", 0))
    return {
        "subtotal": subtotal,
        "tax": tax,
        "balance": balance,
        "late_fee": late_fee(balance, invoice.get("days_late", 0)),
        "due": due_date(date(2026, 9, 1), invoice.get("terms", "net30")).isoformat(),
        "last_payment": last_payment(invoice["payments"]) if invoice.get("payments") else None,
        "email": customer_email(invoice),
    }
