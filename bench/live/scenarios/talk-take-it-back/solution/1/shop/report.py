"""The daily report."""
from . import textutils


def lines(orders):
    return [f"{o['id']:>4} {textutils.money(o['cents']):>10}" for o in orders]
