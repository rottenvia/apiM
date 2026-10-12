def flatten(items):
    """Flattens lists nested to any depth: [1, [2, [3]]] -> [1, 2, 3]."""
    out = []
    for item in items:
        if isinstance(item, list):
            out.extend(flatten(item))
        else:
            out.append(item)
    return out
