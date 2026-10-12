import unittest

from kit.roman import to_roman


class RomanTest(unittest.TestCase):
    def test_roman(self):
        self.assertEqual(to_roman(4), 'IV')
        self.assertEqual(to_roman(1994), 'MCMXCIV')
        self.assertEqual(to_roman(14), 'XIV')
