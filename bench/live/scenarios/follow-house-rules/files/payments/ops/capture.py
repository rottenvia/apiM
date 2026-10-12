from ..errors import InvalidAmount, InvalidState


def capture(payment: dict, amount_cents: int | None = None) -> dict:
    """Capture an authorised payment, in full or in part."""
    if payment["state"] != "authorised":
        raise InvalidState(f"cannot capture a payment that is {payment['state']}")
    amount = payment["amount_cents"] if amount_cents is None else amount_cents
    if type(amount) is not int or not 0 < amount <= payment["amount_cents"]:
        raise InvalidAmount(f"cannot capture {amount!r} of {payment['amount_cents']}")
    return {**payment, "state": "captured", "captured_cents": amount}
