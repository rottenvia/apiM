"""Money as whole cents."""


def to_cents(text):
    """A price as it stands in a CSV cell, in cents: "12.50" is 1250."""
    text = text.strip()
    if "." not in text:
        return int(text) * 100
    whole, frac = text.split(".")
    return int(whole) * 100 + int(frac[:2])


def fmt(cents):
    return f"{cents // 100}.{cents % 100:02d}"
