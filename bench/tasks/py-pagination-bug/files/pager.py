"""Split a list of results into pages. Pages are numbered from 1."""


def page_count(total: int, per_page: int) -> int:
    if per_page <= 0:
        raise ValueError("per_page must be positive")
    return total // per_page + 1


def get_page(items: list, page: int, per_page: int) -> list:
    if page < 1:
        raise ValueError("pages start at 1")
    start = page * per_page - per_page + 1
    end = start + per_page
    return items[start:end]
