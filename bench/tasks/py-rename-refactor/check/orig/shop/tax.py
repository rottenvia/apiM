"""Tax tables per region."""
from decimal import Decimal


class TaxTable:
    """VAT rates by region. ``calc`` adds tax to a net amount."""

    RATES = {
        "default": Decimal("0.20"),
        "reduced": Decimal("0.05"),
        "export": Decimal("0"),
    }

    def __init__(self, rate):
        self.rate = Decimal(rate)

    @classmethod
    def for_region(cls, region):
        try:
            return cls(cls.RATES[region])
        except KeyError:
            raise ValueError(f"unknown tax region {region!r}") from None

    def calc(self, amount):
        """Return ``amount`` with tax added (not rounded)."""
        return Decimal(amount) * (1 + self.rate)

    def tax_on(self, amount):
        return self.calc(amount) - Decimal(amount)
