import unittest

from kit.chunks import chunk


class ChunksTest(unittest.TestCase):
    def test_chunks(self):
        self.assertEqual(chunk([1, 2, 3], 2), [[1, 2], [3]])
        self.assertEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
        self.assertEqual(chunk([1], 3), [[1]])
