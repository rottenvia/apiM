def median(values):
    """The middle value; the mean of the two middle ones for an even count."""
    xs = sorted(values)
    mid = len(xs) // 2
    return xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2
