def camel_to_snake(name):
    """"userName" -> "user_name", "HTTPServerError" -> "http_server_error", "getURL2" -> "get_url2"."""
    import re
    name = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name)
    return name.lower()
