import sys


def convert(text):
    root = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = (part.strip() for part in line.split("=", 1))
        many = key.endswith("[]")
        key = key[:-2] if many else key
        if len(value) >= 2 and value[0] == value[-1] == '"':
            value = value[1:-1]
        elif value.lower() in ("true", "yes", "on"):
            value = "true"
        elif value.lower() in ("false", "no", "off"):
            value = "false"
        elif value == "":
            value = "~"
        node = root
        *parents, last = key.split(".")
        for part in parents:
            child = node.get(part)
            if not isinstance(child, dict):
                child = {} if child is None else {"_": child}
                node[part] = child
            node = child
        if many:
            node.setdefault(last, [])
            node[last].append(value)
        elif isinstance(node.get(last), dict):
            node[last]["_"] = value
        else:
            node[last] = value
    lines = []
    def emit(node, depth):
        for key in sorted(node):
            value, pad = node[key], "  " * depth
            if isinstance(value, dict):
                lines.append(f"{pad}{key}:")
                emit(value, depth + 1)
            elif isinstance(value, list):
                lines.append(f"{pad}{key}:")
                lines.extend(f"{pad}  - {item}" for item in value)
            else:
                lines.append(f"{pad}{key}: {value}")
    emit(root, 0)
    return "\n".join(lines) + "\n"


sys.stdout.write(convert(sys.stdin.read()))
