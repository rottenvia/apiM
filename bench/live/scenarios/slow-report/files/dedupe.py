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
    pairs = []
    for i in range(len(records)):
        for j in range(i + 1, len(records)):
            if norm(records[i]["email"]) == norm(records[j]["email"]):
                pairs.append((i, j))
    return pairs
