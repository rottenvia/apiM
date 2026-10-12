import unittest
from datetime import date

from dates import add_workdays


class DatesTest(unittest.TestCase):
    def test_friday_plus_one_is_monday(self):
        self.assertEqual(add_workdays(date(2026, 10, 9), 1), date(2026, 10, 12))

    def test_zero_days(self):
        self.assertEqual(add_workdays(date(2026, 10, 9), 0), date(2026, 10, 9))
