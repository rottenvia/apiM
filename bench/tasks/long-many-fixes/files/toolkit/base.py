DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def to_base(n, base):
    """The whole number n >= 0 written in the given base (2 to 36), lowercase. Other arguments raise ValueError."""
    if n < 0 or not 2 <= base <= 36:
        raise ValueError("n must be 0 or more and base 2 to 36")
    out = ""
    while n:
        n, r = divmod(n, base)
        out = DIGITS[r] + out
    return out
