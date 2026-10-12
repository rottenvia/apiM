def parse_duration(text):
    """Seconds in a duration like "1h30m15s", "45m" or "90s": hours, minutes and seconds, each optional, in that order. Anything else raises ValueError."""
    import re
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", text)
    if not m or not text:
        raise ValueError(f"not a duration: {text!r}")
    h, mi, s = (int(g or 0) for g in m.groups())
    return h * 3600 + mi * 60 + s
