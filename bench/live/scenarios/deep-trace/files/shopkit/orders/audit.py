"""Audit of orders."""
from shopkit.util import dates


def audit_key(item):
    """What the audit listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_audit(items):
    first = min(items, key=audit_key) if items else None
    return {"count": len(items), "first": first}
