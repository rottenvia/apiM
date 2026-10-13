"""Cohorts of reports."""
from shopkit.util import strings
from shopkit.util.money import fmt


def cohorts_key(item):
    """What the cohorts listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_cohorts(items):
    first = min(items, key=cohorts_key) if items else None
    return {"count": len(items), "first": first}


def cohorts_line(item):
    return f"{item['name']}: {fmt(item.get('cents', 0))}"
