"""Reads the contact lists customers upload."""
from vendor.fastcsv.reader import read_rows


def load_contacts(path):
    """A list of {'name': ..., 'email': ...} from a CSV file with a header row."""
    rows = list(read_rows(path))
    header, body = rows[0], rows[1:]
    return [dict(zip(header, row)) for row in body]
