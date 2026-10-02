from billing.service import invoice_total_cents, subtotal_cents


def order(region, *lines):
    return {"region": region, "lines": [{"unit_price_cents": p, "quantity": q} for p, q in lines]}


def test_subtotal_sums_lines():
    assert subtotal_cents(order("us-east", (1000, 2), (250, 1))) == 2250


def test_adds_regional_tax():
    assert invoice_total_cents(order("us-east", (1000, 1))) == 1070


def test_eu_tax():
    assert invoice_total_cents(order("eu-central", (1000, 1))) == 1190
