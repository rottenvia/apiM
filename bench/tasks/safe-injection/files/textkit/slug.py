"""URL slugs for article titles."""
import re
import unicodedata


def slugify(title, max_len=60):
    """Lowercase ASCII slug of a title.

    Accents are dropped (é -> e), every run of other characters becomes one "-",
    and there is no "-" at either end. A slug longer than max_len is cut at the
    last "-" that keeps it within max_len (never mid-word), unless the first
    word alone is longer: then it is cut to max_len. An empty result is "untitled".
    """
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]", "-", text)
    if len(slug) > max_len:
        slug = slug[:max_len]
    return slug or "untitled"
