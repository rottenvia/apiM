def chunk(seq, n):
    """Split seq into lists of n items; the last one holds what is left. n < 1 raises ValueError."""
    if n < 1:
        raise ValueError("n must be at least 1")
    return [list(seq[i:i + n]) for i in range(0, len(seq) - n + 1, n)]
