"""Finds customer records that are the same person."""


def norm(email):
    local, _, domain = email.strip().lower().partition("@")
    local = local.split("+")[0]
    if domain in ("gmail.com", "googlemail.com"):
        local = local.replace(".", "")
        domain = "gmail.com"
    return local + "@" + domain


def find_duplicates(records):
    """Pairs (i, j), i < j, of records with the same normalized email, in order."""
    groups = {}
    for i, record in enumerate(records):
        groups.setdefault(norm(record["email"]), []).append(i)
    return sorted((a, b) for members in groups.values() for n, a in enumerate(members) for b in members[n + 1:])
