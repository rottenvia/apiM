def with_tax(cents: int, percent: int) -> int:
    """Adds tax to a price in cents."""
    return cents + cents * percent // 100


def split_bill(cents: int, people: int) -> list[int]:
    """Splits a bill so that the shares add up to it exactly."""
    share, rest = divmod(cents, people)
    return [share + (1 if i < rest else 0) for i in range(people)]
