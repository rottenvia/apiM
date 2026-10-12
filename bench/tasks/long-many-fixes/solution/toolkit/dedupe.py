def dedupe(seq):
    """seq without repeats, each item where it FIRST appeared."""
    seen = set()
    out = []
    for item in seq:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out
