"""Mapping of mail."""
from shopkit.util import strings


def mapping_key(item):
    """What the mapping listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_mapping(items):
    first = min(items, key=mapping_key) if items else None
    return {"count": len(items), "first": first}
