def clamp(x, lo, hi):
    """x limited to the range lo..hi. lo > hi raises ValueError."""
    if lo > hi:
        raise ValueError("lo is above hi")
    return max(lo, min(x, hi))
