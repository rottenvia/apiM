import unittest

from shop.cart import Cart, CouponError
from shop.catalog import demo_catalog
from shop.checkout import checkout
from shop.models import Coupon, Customer, TierRule

OR = Customer("c", "OR")


class DiscountTests(unittest.TestCase):
    def test_book_tier(self):
        cart = Cart(demo_catalog())
        cart.add("BK-003", 3)
        self.assertEqual(checkout(cart, OR).tier_discount, 150)

    def test_custom_rules(self):
        cart = Cart(demo_catalog())
        cart.add("EL-001", 2)
        self.assertEqual(checkout(cart, OR, tier_rules=[TierRule("electronics", 2, 10)]).tier_discount, 260)

    def test_stacking(self):
        cart = Cart(demo_catalog())
        cart.add("EL-002")
        cart.apply_coupon(Coupon("F", "fixed", 100))
        cart.apply_coupon(Coupon("P", "percent", 10))
        with self.assertRaises(CouponError):
            cart.apply_coupon(Coupon("Q", "percent", 5))
        self.assertEqual(checkout(cart, OR).applied_coupons, [("P", 460), ("F", 100)])


if __name__ == "__main__":
    unittest.main()
