SMALL = {"a", "an", "and", "of", "the", "in", "on", "to"}


def title_case(text):
    """Headline capitals: every word capitalised except the small words (a, an, and, of, the, in, on, to), which stay
    lowercase unless they are the first or the last word. The rest of each word is lowercased."""
    words = text.split()
    out = []
    for i, word in enumerate(words):
        low = word.lower()
        out.append(low if low in SMALL and 0 < i else low.capitalize())
    return " ".join(out)
