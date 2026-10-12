import os
import tempfile
import unittest

from app.importer import load_contacts

WANT = [{"name": "Ann", "email": "ann@example.org"}, {"name": "Bo", "email": "bo@example.org"}]


def saved(data):
    handle, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(handle, "wb") as f:
        f.write(data)
    return path


class ImportTest(unittest.TestCase):
    def check(self, data):
        path = saved(data)
        try:
            self.assertEqual(load_contacts(path), WANT)
        finally:
            os.remove(path)

    def test_unix_file(self):
        self.check(b"name,email\nAnn,ann@example.org\nBo,bo@example.org\n")

    def test_windows_line_ends(self):
        self.check(b"name,email\r\nAnn,ann@example.org\r\nBo,bo@example.org\r\n")

    def test_windows_byte_order_mark(self):
        self.check(b"\xef\xbb\xbfname,email\nAnn,ann@example.org\nBo,bo@example.org\n")
