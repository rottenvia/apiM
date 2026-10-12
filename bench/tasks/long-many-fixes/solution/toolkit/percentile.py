def percentile(xs, p):
    """The nearest-rank percentile: the smallest value of xs with at least p percent of the values at or below it (0 < p <= 100). Empty raises ValueError."""
    import math
    if not xs or not 0 < p <= 100:
        raise ValueError("needs values and 0 < p <= 100")
    s = sorted(xs)
    return s[math.ceil(p / 100 * len(s)) - 1]
