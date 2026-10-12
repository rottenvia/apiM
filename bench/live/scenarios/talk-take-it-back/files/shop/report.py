"""The daily report."""
from . import utils


def lines(orders):
    return [f"{o['id']:>4} {utils.money(o['cents']):>10}" for o in orders]
