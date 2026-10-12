import unittest

from kit.stats import median


class StatsTest(unittest.TestCase):
    def test_stats(self):
        self.assertEqual(median([3, 1, 2]), 2)
        self.assertEqual(median([4, 1, 3, 2]), 2.5)
        self.assertEqual(median([5]), 5)
