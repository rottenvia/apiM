def merge_intervals(spans):
    """Overlapping or touching (start, end) spans merged, sorted by start: [(1, 2), (2, 3)] -> [(1, 3)]."""
    out = []
    for start, end in sorted(spans):
        if out and start <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out
