"""Sales tax by region."""

DEFAULT_RATE = 0.0

TAX_RATES = {
    "us-east": 0.07,
    "us-west": 0.0825,
    "eu-central": 0.19,
}


def tax_rate(region):
    """The tax rate for a region, as a fraction of the subtotal."""
    return TAX_RATES[region]
