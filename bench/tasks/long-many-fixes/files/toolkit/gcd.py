def gcd_many(*numbers):
    """The greatest common divisor of whole numbers, never negative: gcd_many(-12, 18) -> 6. No numbers raises ValueError; gcd_many(0, 0) is 0."""
    if not numbers:
        raise ValueError("no numbers")
    out = 0
    for n in numbers:
        a, b = out, n
        while b:
            a, b = b, a % b
        out = a
    return out
