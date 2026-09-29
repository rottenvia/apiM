"""Money helpers for the billing service (alternative implementation, same behaviour)."""
import unicodedata
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from fractions import Fraction


def _require_int(v, what):
    if type(v) is bool or not isinstance(v, int):
        raise TypeError(f"{what} must be an int, got {type(v).__name__}")


def _digits(s):
    return bool(s) and all(unicodedata.decimal(c, None) is not None for c in s)


def _parse(text):
    s = text.strip()
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    if s.startswith("$"):
        s = s[1:]
    whole, dot, frac = s.partition(".")
    if dot and not _digits(frac):
        return None
    if "," in whole:
        groups = whole.split(",")
        if not (1 <= len(groups[0]) <= 3) or any(len(g) != 3 for g in groups[1:]):
            return None
        whole = "".join(groups)
    if not _digits(whole):
        return None
    value = Decimal(f"{whole}.{frac or 0}")
    return -value if neg else value


def to_cents(amount):
    if isinstance(amount, (bool, float)):
        raise TypeError(f"unsupported amount type {type(amount).__name__}")
    if isinstance(amount, int):
        return 100 * amount
    if isinstance(amount, Decimal):
        if not amount.is_finite():
            raise ValueError(f"not a finite amount: {amount}")
        value = amount
    elif isinstance(amount, str):
        value = _parse(amount)
        if value is None:
            raise ValueError(f"malformed amount: {amount!r}")
    else:
        raise TypeError(f"unsupported amount type {type(amount).__name__}")
    try:
        return int((value * 100).quantize(Decimal(1), rounding=ROUND_HALF_EVEN))
    except InvalidOperation:
        raise ValueError(f"amount out of range: {amount!r}") from None


def format_cents(cents, symbol="$"):
    _require_int(cents, "cents")
    digits = str(abs(cents)).rjust(3, "0")
    units = int(digits[:-2])
    return ("-" if cents < 0 else "") + symbol + "{:,}".format(units) + "." + digits[-2:]


def split(total, parts):
    _require_int(total, "total")
    _require_int(parts, "parts")
    if parts < 1:
        raise ValueError("parts must be at least 1")
    sign = -1 if total < 0 else 1
    q, r = divmod(abs(total), parts)
    return [sign * (q + (1 if i < r else 0)) for i in range(parts)]


def allocate(total, weights):
    _require_int(total, "total")
    if not weights:
        raise ValueError("weights must not be empty")
    ws = []
    for w in weights:
        if type(w) is bool or not isinstance(w, (int, Decimal)):
            raise TypeError(f"weights must be ints or Decimals, got {type(w).__name__}")
        if w < 0:
            raise ValueError("weights must not be negative")
        ws.append(Fraction(w))
    s = sum(ws)
    if s == 0:
        raise ValueError("weights must not all be zero")
    sign, t = (-1, -total) if total < 0 else (1, total)
    shares, rems = [], []
    for i, w in enumerate(ws):
        q = t * w / s
        base = q.numerator // q.denominator
        shares.append(base)
        rems.append((q - base, -i))
    for _, neg_i in sorted(rems, reverse=True)[: t - sum(shares)]:
        shares[-neg_i] += 1
    return [sign * x for x in shares]
