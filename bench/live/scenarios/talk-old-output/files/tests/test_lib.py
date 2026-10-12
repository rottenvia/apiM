import unittest

from lib import flags, geometry, lists, prices, temps, words


class LibTest(unittest.TestCase):
    def test_all(self):
        self.assertEqual(geometry.area(3, 4), 12)
        self.assertEqual(geometry.perimeter(3, 4), 14)
        self.assertEqual(words.initials("ada king lovelace"), "AKL")
        self.assertEqual(words.count_words("a b  c"), 3)
        self.assertEqual(temps.to_fahrenheit(100), 212)
        self.assertEqual(temps.to_celsius(32), 0)
        self.assertEqual(lists.dedupe([1, 2, 1, 3]), [1, 2, 3])
        self.assertEqual(lists.last([], "x"), "x")
        self.assertEqual(prices.with_tax(1000, 19), 1190)
        self.assertEqual(prices.split_bill(100, 3), [34, 33, 33])
        self.assertTrue(flags.parse_flag(" Yes "))
        self.assertEqual(flags.flag_name("dry_run"), "--dry-run")
