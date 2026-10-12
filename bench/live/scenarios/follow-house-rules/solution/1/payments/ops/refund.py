from ..errors import InvalidAmount, InvalidState


def refund(payment: dict, amount_cents: int) -> dict:
    """Give back part or all of a captured payment."""
    if payment["state"] != "captured":
        raise InvalidState(f"cannot refund a payment that is {payment['state']}")
    left = payment["captured_cents"] - payment["refunded_cents"]
    if type(amount_cents) is not int or not 0 < amount_cents <= left:
        raise InvalidAmount(f"cannot refund {amount_cents!r} of {left}")
    return {**payment, "refunded_cents": payment["refunded_cents"] + amount_cents}
