import unittest

from shopkit.pricing.discounts import apply
from shopkit.util.money import fmt, to_cents


class Money(unittest.TestCase):
    def test_cents(self):
        self.assertEqual(to_cents("12.50"), 1250)
        self.assertEqual(to_cents("40"), 4000)
        self.assertEqual(fmt(1250), "12.50")

    def test_discount_rounds_half_up(self):
        self.assertEqual(apply(1005, "TEN"), 904)
        self.assertEqual(apply(999, "QUARTER"), 749)


if __name__ == "__main__":
    unittest.main()
