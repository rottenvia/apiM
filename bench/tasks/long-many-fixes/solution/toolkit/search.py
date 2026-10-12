def binary_search(xs, x):
    """Index of x in the sorted list xs, or -1 when it is not there."""
    lo, hi = 0, len(xs) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if xs[mid] == x:
            return mid
        if xs[mid] < x:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
