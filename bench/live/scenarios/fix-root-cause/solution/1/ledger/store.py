"""Accounts and their entries, kept in memory."""

_accounts = {}


def open_account(name, entries=None):
    """Opens an account, optionally with opening entries (amounts in cents)."""
    account = {"name": name, "entries": list(entries or [])}
    _accounts[name] = account
    return account


def post(name, cents, memo=""):
    """Adds one entry to an account."""
    _accounts[name]["entries"].append({"account": name, "cents": cents, "memo": memo})


def transfer(source, target, cents):
    """Moves money between two accounts."""
    post(source, -cents, f"to {target}")
    post(target, cents, f"from {source}")


def get(name):
    return _accounts[name]


def reset():
    """Forgets every account (tests call this)."""
    _accounts.clear()
