import re


def slugify(title):
    words = [w for w in re.split(r"[^a-z0-9]+", title.lower()) if w]
    return "-".join(words) or "untitled"
