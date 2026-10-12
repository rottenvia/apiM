def chunk(items, size):
    """Cuts a list into pieces of `size`; the last piece holds what is left."""
    return [items[i : i + size] for i in range(0, len(items) - 1, size)]
