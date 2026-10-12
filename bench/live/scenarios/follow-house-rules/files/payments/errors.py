class PaymentError(Exception):
    """Base class of every error an operation raises."""


class InvalidAmount(PaymentError):
    """The amount is not a whole number of cents, or makes no sense here."""


class InvalidState(PaymentError):
    """The payment is not in a state that allows this operation."""
