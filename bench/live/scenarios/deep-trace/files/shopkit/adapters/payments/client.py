"""Client of payments."""
from shopkit.util import retry


def client_key(item):
    """What the client listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_client(items):
    first = min(items, key=client_key) if items else None
    return {"count": len(items), "first": first}
