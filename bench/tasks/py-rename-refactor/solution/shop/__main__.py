"""Command line: python -m shop calc 9.99:2 5:1 --region reduced"""
import argparse
import sys

from .pricing import calculate_total
from .tax import TaxTable


def parse_line(text):
    price, _, qty = text.partition(":")
    return price, int(qty or 1)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="shop")
    sub = parser.add_subparsers(dest="command", required=True)
    p_calc = sub.add_parser("calc", help="calc the gross total for PRICE:QTY items")
    p_calc.add_argument("items", nargs="+")
    p_calc.add_argument("--region", default="default")
    p_tax = sub.add_parser("tax", help="show the tax on a net amount")
    p_tax.add_argument("amount")
    p_tax.add_argument("--region", default="default")
    args = parser.parse_args(argv)
    if args.command == "calc":
        print(calculate_total([parse_line(i) for i in args.items], args.region))
    else:
        print(f"{TaxTable.for_region(args.region).tax_on(args.amount):.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
