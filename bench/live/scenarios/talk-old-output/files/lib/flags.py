def parse_flag(text):
    return text.strip().lower() in ("1", "true", "yes", "on")


def flag_name(key):
    return "--" + key.replace("_", "-")
