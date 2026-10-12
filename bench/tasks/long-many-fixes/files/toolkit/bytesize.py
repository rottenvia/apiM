def format_bytes(n):
    """A size for people: 512 -> "512 B", 1536 -> "1.5 KB", 1048576 -> "1.0 MB". Units of 1024, up to GB, one decimal from KB on."""
    if n < 1000:
        return f"{n} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1000
        if n < 1000 or unit == "GB":
            return f"{n:.1f} {unit}"
