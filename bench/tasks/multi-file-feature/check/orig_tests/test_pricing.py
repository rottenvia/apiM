import unittest

from shop import pricing
from shop.models import Coupon
from shop.money import fmt, percent_of, round_half_up


class MoneyTests(unittest.TestCase):
    def test_round_half_up(self):
        self.assertEqual(round_half_up(0.5), 1)
        self.assertEqual(round_half_up(2.5), 3)
        self.assertEqual(round_half_up(2.4999), 2)

    def test_percent_of(self):
        self.assertEqual(percent_of(1999, 10), 200)
        self.assertEqual(percent_of(333, 5), 17)

    def test_fmt(self):
        self.assertEqual(fmt(5), "0.05")
        self.assertEqual(fmt(123456), "1234.56")
        self.assertEqual(fmt(-250), "-2.50")


class PricingTests(unittest.TestCase):
    def test_coupon_discount(self):
        self.assertEqual(pricing.coupon_discount(Coupon("P10", "percent", 10), 4999), 500)
        self.assertEqual(pricing.coupon_discount(Coupon("F5", "fixed", 500), 300), 300)
        self.assertEqual(pricing.coupon_discount(Coupon("MIN", "fixed", 500, 3000), 2999), 0)
        self.assertEqual(pricing.coupon_discount(None, 1000), 0)

    def test_tax(self):
        self.assertEqual(pricing.tax("CA", 10000), 725)
        self.assertEqual(pricing.tax("OR", 10000), 0)
        self.assertEqual(pricing.tax("ZZ", 1999), 100)

    def test_shipping(self):
        self.assertEqual(pricing.shipping(4999), 599)
        self.assertEqual(pricing.shipping(5000), 0)
        self.assertEqual(pricing.shipping(0), 0)

    def test_bad_coupons(self):
        with self.assertRaises(ValueError):
            Coupon("X", "bogus", 5)
        with self.assertRaises(ValueError):
            Coupon("X", "percent", 150)


if __name__ == "__main__":
    unittest.main()
