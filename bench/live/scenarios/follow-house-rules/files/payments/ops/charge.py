from ..errors import InvalidAmount


def charge(customer: str, amount_cents: int) -> dict:
    """Create an authorised payment for a customer."""
    if type(amount_cents) is not int or amount_cents <= 0:
        raise InvalidAmount(f"cannot charge {amount_cents!r}")
    return {"customer": customer, "amount_cents": amount_cents, "state": "authorised", "captured_cents": 0, "refunded_cents": 0}
