def initials(name):
    return "".join(part[0].upper() for part in name.split())


def count_words(text):
    return len(text.split())
