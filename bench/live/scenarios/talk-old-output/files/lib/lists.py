def dedupe(items):
    seen = []
    for item in items:
        if item not in seen:
            seen.append(item)
    return seen


def last(items, default=None):
    return items[-1] if items else default
