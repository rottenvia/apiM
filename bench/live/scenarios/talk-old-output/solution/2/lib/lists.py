def dedupe(items: list) -> list:
    """Drops repeats, keeping the first of each."""
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def last(items: list, default: object = None) -> object:
    """Returns the last item, or the default for an empty list."""
    return items[-1] if items else default
