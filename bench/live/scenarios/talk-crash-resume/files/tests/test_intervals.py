import unittest

from kit.intervals import merge


class IntervalsTest(unittest.TestCase):
    def test_intervals(self):
        self.assertEqual(merge([[1, 2], [2, 3]]), [[1, 3]])
        self.assertEqual(merge([[5, 6], [1, 3], [2, 4]]), [[1, 4], [5, 6]])
        self.assertEqual(merge([[1, 2], [3, 4]]), [[1, 2], [3, 4]])
