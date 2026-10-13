"""What being late costs."""
from datetime import date

FINE_PER_DAY = 25
FREE_DAYS = 2


def fine_cents(loan, state, today):
    """What a loan costs for being late, in cents. A loan that is back counts up to the day it came back."""
    end = date.fromisoformat(loan["returned"]) if loan["returned"] else today
    late = (end - date.fromisoformat(loan["due"])).days
    return max(0, late - FREE_DAYS) * FINE_PER_DAY
