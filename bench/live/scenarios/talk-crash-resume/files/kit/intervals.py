def merge(intervals):
    """Merges overlapping intervals; ones that only touch ([1, 2] and [2, 3]) merge too."""
    out = []
    for start, end in sorted(intervals):
        if out and start < out[-1][1]:
            out[-1][1] = max(out[-1][1], end)
        else:
            out.append([start, end])
    return out
