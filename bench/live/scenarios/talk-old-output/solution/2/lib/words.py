def initials(name: str) -> str:
    """Returns the first letters of a name, in upper case."""
    return "".join(part[0].upper() for part in name.split())


def count_words(text: str) -> int:
    """Counts the words of a text."""
    return len(text.split())
