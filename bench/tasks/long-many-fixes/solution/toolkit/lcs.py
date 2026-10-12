def lcs_length(a, b):
    """Length of the longest common subsequence of two texts (letters in order, not necessarily next to each other)."""
    row = [0] * (len(b) + 1)
    for x in a:
        prev = 0
        for j, y in enumerate(b, 1):
            keep = row[j]
            row[j] = prev + 1 if x == y else max(row[j], row[j - 1])
            prev = keep
    return row[-1]
