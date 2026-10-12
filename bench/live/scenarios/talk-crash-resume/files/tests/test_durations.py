import unittest

from kit.durations import parse


class DurationsTest(unittest.TestCase):
    def test_durations(self):
        self.assertEqual(parse('1h30m'), 5400)
        self.assertEqual(parse('45s'), 45)
        self.assertEqual(parse('2h'), 7200)
