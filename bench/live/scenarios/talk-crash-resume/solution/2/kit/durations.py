import re

UNITS = {"h": 3600, "m": 60, "s": 1}


def parse(text):
    """'1h30m' -> 5400, '45s' -> 45. Raises ValueError for anything else."""
    parts = re.findall(r"(\d+)([hms])", text)
    if not parts or "".join(n + u for n, u in parts) != text:
        raise ValueError(text)
    return sum(int(n) * UNITS[u] for n, u in parts)
