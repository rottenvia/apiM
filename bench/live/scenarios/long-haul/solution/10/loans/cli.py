"""python -m loans [--store FILE] [--today YYYY-MM-DD] COMMAND ..."""
import argparse
import sys
from datetime import date

from loans import core


def money(cents):
    """1250 -> '12.50'."""
    return f"{cents // 100}.{cents % 100:02d}"


def to_cents(text):
    """'12.50' -> 1250, with no float in between."""
    whole, _, part = text.partition(".")
    if not whole.isdigit() or not (part or "0").isdigit() or len(part) > 2:
        raise core.LoanError(f"not a price: {text}")
    return int(whole) * 100 + int(part.ljust(2, "0"))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="loans")
    parser.add_argument("--store", default="store.json")
    parser.add_argument("--today", type=date.fromisoformat, default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("add-book")
    p.add_argument("id")
    p.add_argument("title")
    p.add_argument("price", help="like 12.50")
    p = sub.add_parser("add-member")
    p.add_argument("id")
    p.add_argument("name")
    p = sub.add_parser("lend")
    p.add_argument("book")
    p.add_argument("member")
    p = sub.add_parser("return")
    p.add_argument("book")
    p = sub.add_parser("renew")
    p.add_argument("book")
    sub.add_parser("report")
    sub.add_parser("overdue")
    args = parser.parse_args(argv)
    today = args.today or date.today()
    state = core.load(args.store)
    try:
        if args.command == "add-book":
            core.add_book(state, args.id, args.title, to_cents(args.price))
        elif args.command == "add-member":
            core.add_member(state, args.id, args.name)
        elif args.command == "lend":
            print(f"due {core.lend(state, args.book, args.member, today)['due']}")
        elif args.command == "return":
            fine = core.fine_cents(core.give_back(state, args.book, today), state, today)
            if fine:
                print(f"fine: {money(fine)}")
        elif args.command == "renew":
            print(f"due {core.renew(state, args.book)['due']}")
        elif args.command == "report":
            print("\n".join(core.report(state)))
        elif args.command == "overdue":
            print("\n".join(f"{late}  {book}  {member}  {money(fine)}" for late, book, member, fine in core.overdue(state, today)) or "nothing overdue")
    except core.LoanError as e:
        print(f"loans: {e}", file=sys.stderr)
        return 2
    core.save(args.store, state)
    return 0
