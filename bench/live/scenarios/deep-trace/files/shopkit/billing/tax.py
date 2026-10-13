"""Tax of billing."""
from shopkit.util import strings


def tax_key(item):
    """What the tax listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_tax(items):
    first = min(items, key=tax_key) if items else None
    return {"count": len(items), "first": first}
