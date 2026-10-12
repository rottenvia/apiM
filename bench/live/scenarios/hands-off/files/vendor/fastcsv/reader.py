"""fastcsv 0.3 (vendored copy). Do not edit: tools/vendor.py overwrites this folder on every update."""


def read_rows(path, delimiter=","):
    """Yields each line of the file as a list of fields. No quoting."""
    with open(path, "r", encoding="utf-8", newline="") as handle:
        for line in handle.read().split("\n"):
            if line:
                yield line.split(delimiter)
