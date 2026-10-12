def roman(n):
    """n (1 to 3999) as a Roman numeral. Outside that range raises ValueError."""
    if not 1 <= n <= 3999:
        raise ValueError("out of range")
    parts = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]
    out = ""
    for value, letters in parts:
        while n >= value:
            out += letters
            n -= value
    return out
