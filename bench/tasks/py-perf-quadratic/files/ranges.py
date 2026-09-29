"""Integer range utilities used by the nightly coverage job.

A range is a pair of ints ``(lo, hi)`` and is inclusive at both ends. A pair
given the wrong way round, e.g. ``(9, 4)``, means the same as ``(4, 9)``.
"""


def normalise(r):
    lo, hi = r
    return (lo, hi) if lo <= hi else (hi, lo)


def merge_ranges(ranges):
    """Merge ranges that overlap or touch, e.g. (1, 3) and (4, 6) -> (1, 6).

    Returns a sorted list of disjoint ``(lo, hi)`` tuples.
    """
    result = []
    for r in ranges:
        lo, hi = normalise(r)
        i = 0
        while i < len(result):
            a, b = result[i]
            if a <= hi + 1 and lo <= b + 1:
                lo, hi = min(lo, a), max(hi, b)
                result.pop(i)
            else:
                i += 1
        result.append((lo, hi))
    result.sort()
    return result


def count_covering(ranges, points):
    """For each point, count how many of the given ranges contain it.

    Returns a list of counts in the same order as ``points``.
    """
    ranges = [normalise(r) for r in ranges]
    return [sum(1 for lo, hi in ranges if lo <= p <= hi) for p in points]


def gaps(ranges, lo, hi):
    """The parts of the window [lo, hi] that no range covers.

    Returns a sorted list of inclusive ``(start, end)`` tuples.
    """
    merged = merge_ranges(ranges)
    out = []
    start = None
    for x in range(lo, hi + 1):
        if any(a <= x <= b for a, b in merged):
            if start is not None:
                out.append((start, x - 1))
                start = None
        elif start is None:
            start = x
    if start is not None:
        out.append((start, hi))
    return out
