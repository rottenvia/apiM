"""Shop-wide settings."""

# tax rates in basis points (1/100 of a percent) by region; anything else pays DEFAULT_TAX_BP
TAX_RATES_BP = {"CA": 725, "NY": 400, "TX": 625, "OR": 0}
DEFAULT_TAX_BP = 500

FLAT_SHIPPING_CENTS = 599
FREE_SHIPPING_THRESHOLD_CENTS = 5000  # merchandise after discounts

from .models import TierRule  # noqa: E402

# quantity tiers per category; the highest min_qty reached applies
DEFAULT_TIER_RULES = [
    TierRule("books", 3, 5),
    TierRule("books", 6, 10),
    TierRule("stationery", 10, 15),
]
