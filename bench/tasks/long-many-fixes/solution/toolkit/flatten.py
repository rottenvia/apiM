def flatten(nested):
    """All the items of lists nested to any depth, as one flat list, in order. Texts are items, not lists."""
    out = []
    for item in nested:
        if isinstance(item, (list, tuple)):
            out.extend(flatten(item))
        else:
            out.append(item)
    return out
