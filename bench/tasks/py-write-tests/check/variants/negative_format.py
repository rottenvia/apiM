"""Money helpers for the billing service.

All amounts are handled as integer numbers of cents. Only the four public
functions below are part of the API.
"""
import re
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from fractions import Fraction

_AMOUNT = re.compile(r"(-)?\$?((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d+))?")


def _check_int(value, name):
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value).__name__}")


def to_cents(amount):
    """Convert ``amount`` to an int number of cents.

    * ``int``: a whole number of currency units, so ``to_cents(5) == 500``.
    * ``Decimal``: converted by value; a non-finite Decimal raises ``ValueError``.
    * ``str``: a decimal number with an optional leading ``-``, an optional
      ``$`` right after the sign, and optional ``,`` thousands separators
      (which must then separate groups of exactly three digits). Surrounding
      whitespace is ignored. For example ``"-$1,234.5"`` is ``-123450``.
      Anything else raises ``ValueError``.
    * Any other type, including ``float`` and ``bool``, raises ``TypeError``.

    Amounts with more than two decimal places are rounded to the nearest
    cent; an amount exactly halfway between two cents goes to the even one
    (banker's rounding). Negative amounts round the same way as their
    positive counterparts, mirrored.
    """
    if isinstance(amount, bool) or isinstance(amount, float):
        raise TypeError(f"unsupported amount type {type(amount).__name__}")
    if isinstance(amount, int):
        return amount * 100
    if isinstance(amount, Decimal):
        if not amount.is_finite():
            raise ValueError(f"not a finite amount: {amount}")
        value = amount
    elif isinstance(amount, str):
        m = _AMOUNT.fullmatch(amount.strip())
        if not m:
            raise ValueError(f"malformed amount: {amount!r}")
        sign, whole, frac = m.groups()
        value = Decimal(whole.replace(",", "") + "." + (frac or "0"))
        if sign:
            value = -value
    else:
        raise TypeError(f"unsupported amount type {type(amount).__name__}")
    try:
        return int((value * 100).quantize(Decimal(1), rounding=ROUND_HALF_EVEN))
    except InvalidOperation:
        raise ValueError(f"amount out of range: {amount!r}") from None


def format_cents(cents, symbol="$"):
    """Format an int number of cents for display.

    ``format_cents(123456) == "$1,234.56"``. Whole units get ``,`` thousands
    separators and there are always exactly two decimals. Negative amounts
    get a leading minus sign, before the symbol. ``symbol`` replaces ``"$"``
    (it may be empty or several characters). A non-int (or bool) raises
    ``TypeError``.
    """
    _check_int(cents, "cents")
    sign = "-" if cents < 0 else ""
    units, rem = divmod(cents, 100)
    return f"{sign}{symbol}{abs(units):,}.{rem:02d}"


def split(total, parts):
    """Split ``total`` cents into ``parts`` shares that differ by at most one cent.

    The shares add up to ``total`` exactly and the larger shares come first:
    ``split(100, 3) == [34, 33, 33]``. A negative total is split as the mirror
    image of the positive one. ``parts`` must be a positive int
    (``ValueError`` otherwise); both arguments must be ints (``TypeError``).
    """
    _check_int(total, "total")
    _check_int(parts, "parts")
    if parts < 1:
        raise ValueError("parts must be at least 1")
    if total < 0:
        return [-share for share in split(-total, parts)]
    base, extra = divmod(total, parts)
    return [base + 1] * extra + [base] * (parts - extra)


def allocate(total, weights):
    """Allocate ``total`` cents in proportion to ``weights``.

    ``weights`` is a non-empty list of non-negative ints or Decimals whose sum
    is positive (``ValueError`` otherwise). Uses the largest remainder method:
    every entry first gets its exact share rounded down; the cents that are
    left over then go, one each, to the entries with the largest fractional
    remainders, with ties going to the earlier entry. The result always sums
    to ``total``. A negative total is allocated as the mirror image of the
    positive one. Example: ``allocate(100, [1, 1, 1]) == [34, 33, 33]``.
    """
    _check_int(total, "total")
    if not weights:
        raise ValueError("weights must not be empty")
    fracs = []
    for w in weights:
        if isinstance(w, bool) or not isinstance(w, (int, Decimal)):
            raise TypeError(f"weights must be ints or Decimals, got {type(w).__name__}")
        if w < 0:
            raise ValueError("weights must not be negative")
        fracs.append(Fraction(w))
    whole = sum(fracs)
    if whole == 0:
        raise ValueError("weights must not all be zero")
    if total < 0:
        return [-share for share in allocate(-total, weights)]
    exact = [total * f / whole for f in fracs]
    shares = [int(e) for e in exact]
    left = total - sum(shares)
    order = sorted(range(len(exact)), key=lambda i: (-(exact[i] - shares[i]), i))
    for i in order[:left]:
        shares[i] += 1
    return shares
