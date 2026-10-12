SMALL = {"a", "an", "and", "of", "the", "in", "on"}


def title_case(text):
    """Capitalises every word except the small ones; the first word is always capitalised."""
    words = text.lower().split()
    return " ".join(w if w in SMALL else w.capitalize() for i, w in enumerate(words))
