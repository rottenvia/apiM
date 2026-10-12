"""What an account holder is shown."""
from . import store


def balance(name):
    """The account's balance in cents."""
    return sum(entry["cents"] for entry in store.get(name)["entries"])


def statement(name):
    """One line per entry, then the balance."""
    lines = [f"{entry['memo'] or 'entry'}: {entry['cents'] / 100:.2f}" for entry in store.get(name)["entries"]]
    return lines + [f"balance: {balance(name) / 100:.2f}"]
