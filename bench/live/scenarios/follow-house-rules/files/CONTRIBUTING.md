# Working on payments

1. One operation, one module: `payments/ops/<name>.py`, holding a function of the same name. It is added to `REGISTRY` in `payments/ops/__init__.py`, or the API cannot call it.
2. An operation never changes the record it is given. It returns a new one.
3. Amounts are whole cents (`int`). An operation refuses anything else, and any amount that makes no sense, with `InvalidAmount`.
4. Operations raise only subclasses of `PaymentError` (`payments/errors.py`). A payment in the wrong state is `InvalidState`. Never `ValueError` or a bare `Exception`: the API turns `PaymentError` into a 4xx and everything else into a 500.
5. Every operation has its tests in `tests/test_<name>.py` (unittest).
6. Every change a user can notice gets one line under `## Unreleased` in `CHANGELOG.md`.
