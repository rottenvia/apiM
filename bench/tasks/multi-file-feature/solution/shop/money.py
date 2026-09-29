from __future__ import annotations

from fractions import Fraction


def round_half_up(value) -> int:
    """Round a non-negative Fraction/int/Decimal to the nearest int, halves up."""
    value = Fraction(value)
    return int((value * 2 + 1) // 2)


def percent_of(cents: int, percent) -> int:
    """`percent`% of `cents`, rounded half up to a whole cent."""
    return round_half_up(Fraction(cents) * Fraction(percent) / 100)


def fmt(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
