import re


def slugify(title, limit=40):
    words = [w for w in re.split(r"[^a-z0-9]+", title.lower()) if w]
    if not words:
        return "untitled"
    out = words[0][:limit]
    for word in words[1:]:
        if len(out) + 1 + len(word) > limit:
            break
        out += "-" + word
    return out


def unique_slug(title, taken):
    base = slugify(title)
    slug, n = base, 2
    while slug in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug
