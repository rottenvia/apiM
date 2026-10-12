def median(xs):
    """The middle value of xs; the mean of the two middle values when there is an even number. Empty raises ValueError. xs is not changed."""
    if not xs:
        raise ValueError("no values")
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2
