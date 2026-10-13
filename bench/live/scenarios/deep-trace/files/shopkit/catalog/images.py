"""Images of catalog."""
from shopkit.util import log


def images_key(item):
    """What the images listing is sorted by."""
    return (item.get("rank", 0), item.get("name", ""))


def summarize_images(items):
    first = min(items, key=images_key) if items else None
    return {"count": len(items), "first": first}
