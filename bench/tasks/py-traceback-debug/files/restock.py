"""Usage: python3 restock.py STOCK_CSV ORDERS_JSONL"""
import sys

from inventory import tally
from loader import load_orders, load_stock
from planner import plan
from report import render


def main(argv):
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    stock = load_stock(argv[1])
    orders = load_orders(argv[2])
    restock, unknown = plan(stock, tally(orders))
    print(render(restock, unknown))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
