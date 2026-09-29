import unittest
from decimal import Decimal

from shop import Cart, Discount, best_discount, calc
from shop.invoice import render_invoice


class ShopTests(unittest.TestCase):
    def test_calc_default_region(self):
        self.assertEqual(calc([("10.00", 2)]), Decimal("24.00"))

    def test_calc_with_discount(self):
        self.assertEqual(calc([("100", 1)], "reduced", Discount("x", percent=10)), Decimal("94.50"))

    def test_cart(self):
        self.assertEqual(Cart("export").add("3.33", 3).total(), Decimal("9.99"))

    def test_best_discount(self):
        a, b = Discount("a", percent=5), Discount("b", amount_off=10)
        self.assertIs(best_discount([("50", 1)], [a, b]), b)

    def test_invoice(self):
        self.assertIn("Total: 12.00", render_invoice("Ann", [("5", 2)]))


if __name__ == "__main__":
    unittest.main()
