import unittest

from shop.cart import Cart, CartError
from shop.catalog import demo_catalog
from shop.checkout import checkout, format_receipt
from shop.models import Coupon, Customer

CA = Customer("c1", "CA")
OR = Customer("c2", "OR")


class CheckoutTests(unittest.TestCase):
    def setUp(self):
        self.cart = Cart(demo_catalog())

    def test_simple_order(self):
        self.cart.add("EL-001")          # 12.99
        self.cart.add("ST-002", 2)       # 3.98
        order = checkout(self.cart, CA)
        self.assertEqual(order.subtotal, 1697)
        self.assertEqual(order.discount, 0)
        self.assertEqual(order.tax, 123)
        self.assertEqual(order.shipping, 599)
        self.assertEqual(order.total, 1697 + 123 + 599)

    def test_free_shipping(self):
        self.cart.add("EL-002")          # 45.99
        self.cart.add("EL-001")          # 12.99
        order = checkout(self.cart, OR)
        self.assertEqual(order.shipping, 0)
        self.assertEqual(order.total, 5898)

    def test_percent_coupon(self):
        self.cart.add("EL-002")
        self.cart.apply_coupon(Coupon("TEN", "percent", 10))
        order = checkout(self.cart, OR)
        self.assertEqual(order.discount, 460)
        self.assertEqual(order.total, 4599 - 460 + 599)

    def test_coupon_below_minimum_is_ignored(self):
        self.cart.add("ST-001")
        self.cart.apply_coupon(Coupon("BIG", "fixed", 1000, min_subtotal_cents=5000))
        order = checkout(self.cart, OR)
        self.assertEqual(order.discount, 0)
        self.assertEqual(order.total, 450 + 599)

    def test_fixed_coupon_cannot_go_negative(self):
        self.cart.add("ST-002")
        self.cart.apply_coupon(Coupon("F50", "fixed", 5000))
        order = checkout(self.cart, CA)
        self.assertEqual(order.discount, 199)
        self.assertEqual((order.tax, order.shipping, order.total), (0, 0, 0))

    def test_empty_cart(self):
        with self.assertRaises(CartError):
            checkout(self.cart, CA)

    def test_receipt(self):
        self.cart.add("BK-002", 2)
        order = checkout(self.cart, OR)
        receipt = format_receipt(order)
        self.assertIn("2 x Soup for Programmers", receipt)
        self.assertRegex(receipt, r"Total\s+42\.99")


if __name__ == "__main__":
    unittest.main()
