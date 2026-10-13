"""Loans of a small library. The state is one JSON file."""
import json
from datetime import date, timedelta
from pathlib import Path

LOAN_DAYS = 14


class LoanError(Exception):
    """Something asked for that cannot be done; the command line prints it and exits with 2."""


def load(path):
    path = Path(path)
    if not path.exists():
        return {"books": {}, "members": {}, "loans": []}
    return json.loads(path.read_text("utf-8"))


def save(path, state):
    Path(path).write_text(json.dumps(state, indent=1, sort_keys=True) + "\n", "utf-8")


def add_book(state, book_id, title, price_cents):
    if book_id in state["books"]:
        raise LoanError(f"book {book_id} exists already")
    state["books"][book_id] = {"title": title, "price_cents": price_cents}


def add_member(state, member_id, name):
    if member_id in state["members"]:
        raise LoanError(f"member {member_id} exists already")
    state["members"][member_id] = {"name": name}


def open_loan(state, book_id):
    """The loan a book is out on, or None."""
    return next((loan for loan in state["loans"] if loan["book"] == book_id and loan["returned"] is None), None)


def lend(state, book_id, member_id, today):
    if book_id not in state["books"]:
        raise LoanError(f"no book {book_id}")
    if member_id not in state["members"]:
        raise LoanError(f"no member {member_id}")
    if open_loan(state, book_id):
        raise LoanError(f"book {book_id} is out")
    loan = {"book": book_id, "member": member_id, "lent": today.isoformat(), "due": (today + timedelta(days=LOAN_DAYS)).isoformat(), "returned": None}
    state["loans"].append(loan)
    return loan


def give_back(state, book_id, today):
    loan = open_loan(state, book_id)
    loan["returned"] = today.isoformat()
    return loan


def report(state):
    """One line per loan that is still out, in the order they were lent."""
    out = [loan for loan in state["loans"] if loan["returned"] is None]
    if not out:
        return ["no loans"]
    width = max(len(state["books"][loan["book"]]["title"]) for loan in out)
    return [f"{state['books'][loan['book']]['title'].ljust(width)}  {loan['member']}  due {loan['due']}" for loan in out]
