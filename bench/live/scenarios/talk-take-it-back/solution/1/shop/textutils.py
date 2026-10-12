"""Small helpers shared by the shop modules."""


def money(cents):
    """Formats integer cents as a price: 1234 -> '12.34'."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def clamp(value, low, high):
    """Keeps value between low and high."""
    return max(low, min(high, value))


def shout(text):
    """Upper case, with one exclamation mark at the end."""
    text = text.upper()
    return text if text.endswith("!") else text + "!"
