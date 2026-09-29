"""Integer range utilities used by the nightly coverage job.

A range is a pair of ints ``(lo, hi)`` and is inclusive at both ends. A pair
given the wrong way round, e.g. ``(9, 4)``, means the same as ``(4, 9)``.
"""
from bisect import bisect_left, bisect_right


def normalise(r):
    lo, hi = r
    return (lo, hi) if lo <= hi else (hi, lo)


def merge_ranges(ranges):
    """Merge ranges that overlap or touch, e.g. (1, 3) and (4, 6) -> (1, 6).

    Returns a sorted list of disjoint ``(lo, hi)`` tuples.
    """
    out = []
    for lo, hi in sorted(normalise(r) for r in ranges):
        if out and lo <= out[-1][1] + 1:
            if hi > out[-1][1]:
                out[-1] = (out[-1][0], hi)
        else:
            out.append((lo, hi))
    return out


def count_covering(ranges, points):
    """For each point, count how many of the given ranges contain it.

    Returns a list of counts in the same order as ``points``.
    """
    ranges = [normalise(r) for r in ranges]
    starts = sorted(lo for lo, _ in ranges)
    ends = sorted(hi for _, hi in ranges)
    # ranges containing p = (starts <= p) - (ends < p)
    return [bisect_right(starts, p) - bisect_left(ends, p) for p in points]


def gaps(ranges, lo, hi):
    """The parts of the window [lo, hi] that no range covers.

    Returns a sorted list of inclusive ``(start, end)`` tuples.
    """
    out = []
    cursor = lo
    for a, b in merge_ranges(ranges):
        if cursor > hi:
            break
        if b < cursor:
            continue
        if a > cursor:
            out.append((cursor, min(a - 1, hi)))
        cursor = b + 1
    if cursor <= hi:
        out.append((cursor, hi))
    return out
