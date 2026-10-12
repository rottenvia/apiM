def parse_kv(text):
    """ "a=1; b = two ; c=" -> {"a": "1", "b": "two", "c": ""}. Pairs are split on ";", names and values trimmed;
    a value may itself hold "=". Empty pieces are skipped; a piece without "=" raises ValueError."""
    out = {}
    for piece in text.split(";"):
        if not piece.strip():
            continue
        if "=" not in piece:
            raise ValueError(f"no '=' in {piece!r}")
        key, value = piece.split("=", 1)
        out[key.strip()] = value.strip()
    return out
