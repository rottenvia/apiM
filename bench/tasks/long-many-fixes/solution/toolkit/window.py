def running_mean(xs, k):
    """The mean of every run of k values next to each other in xs: running_mean([1, 2, 3, 4], 2) -> [1.5, 2.5, 3.5]. k < 1 raises ValueError; fewer than k values gives []."""
    if k < 1:
        raise ValueError("k must be at least 1")
    return [sum(xs[i:i + k]) / k for i in range(len(xs) - k + 1)]
