"""Ledger of billing."""
from shopkit.util import log
from shopkit.util.money import fmt


def ledger_key(item):
    """What the ledger listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_ledger(items):
    first = min(items, key=ledger_key) if items else None
    return {"count": len(items), "first": first}


def ledger_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"
