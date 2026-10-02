from datetime import date

from billing.invoice import due_date, line_total, terms_days


def test_prices_a_line_by_quantity():
    assert line_total({"sku": "A", "unit_price_cents": 250, "quantity": 4}) == 1000


def test_net30_terms():
    assert terms_days("net30") == 30


def test_due_date_adds_the_terms():
    assert due_date(date(2026, 9, 1), "net15") == date(2026, 9, 16)
