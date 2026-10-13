"""Slugs for URLs."""
import re

SEPARATORS = re.compile(r"[^a-z0-9]+")
FOLD = str.maketrans("àáâäçèéêëìíîïñòóôöùúûüß", "aaaaceeeeiiiinoooouuuus")
STOPWORDS = {"a", "an", "the", "of", "and"}


def slugify(title, max_length=None, drop_stopwords=False):
    slug = SEPARATORS.sub("-", title.lower().translate(FOLD)).strip("-")
    if drop_stopwords:
        slug = "-".join(word for word in slug.split("-") if word not in STOPWORDS)
    if max_length and len(slug) > max_length:
        slug = slug[:max_length + 1].rsplit("-", 1)[0][:max_length]
    return slug
