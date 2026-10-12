PAIRS = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (1, "I")]


def to_roman(number):
    """1994 -> 'MCMXCIV'."""
    out = ""
    for value, letters in PAIRS:
        while number >= value:
            out += letters
            number -= value
    return out
