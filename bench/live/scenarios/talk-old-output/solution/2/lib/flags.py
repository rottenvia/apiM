def parse_flag(text: str) -> bool:
    """Reads a yes or no from a setting's text."""
    return text.strip().lower() in ("1", "true", "yes", "on")


def flag_name(key: str) -> str:
    """Turns a setting's key into its command-line flag."""
    return "--" + key.replace("_", "-")
