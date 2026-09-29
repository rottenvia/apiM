import re
import unittest

from shop import settings
from shop.cart import Cart, CouponError
from shop.catalog import demo_catalog
from shop.checkout import checkout, format_receipt
from shop.models import Coupon, Customer, TierRule

CA = Customer("c1", "CA")
OR = Customer("c2", "OR")


def cart_with(*items):
    cart = Cart(demo_catalog())
    for sku, qty in items:
        cart.add(sku, qty)
    return cart


class TierDiscounts(unittest.TestCase):
    def test_default_rules_books_5_percent(self):
        order = checkout(cart_with(("BK-001", 2), ("BK-003", 1)), OR)
        self.assertEqual(order.tier_discount, 250 + 50)
        self.assertEqual(order.discount, 300)
        self.assertEqual((order.shipping, order.total), (0, 5697))

    def test_default_rules_books_10_percent(self):
        order = checkout(cart_with(("BK-003", 6)), OR)
        self.assertEqual(order.tier_discount, 599)

    def test_below_first_tier(self):
        order = checkout(cart_with(("BK-001", 2), ("ST-002", 9)), OR)
        self.assertEqual(order.tier_discount, 0)
        self.assertEqual(order.discount, 0)

    def test_default_rules_stationery(self):
        order = checkout(cart_with(("ST-001", 4), ("ST-002", 6), ("EL-001", 1)), OR)
        self.assertEqual(order.tier_discount, 270 + 179)

    def test_default_rules_exist(self):
        rules = {(r.category, r.min_qty, r.percent) for r in settings.DEFAULT_TIER_RULES}
        self.assertEqual(rules, {("books", 3, 5), ("books", 6, 10), ("stationery", 10, 15)})

    def test_rounding_is_per_line(self):
        order = checkout(cart_with(("BK-003", 1), ("BK-002", 1)), OR, tier_rules=[TierRule("books", 2, 5)])
        self.assertEqual(order.tier_discount, 50 + 93)

    def test_rules_in_any_order(self):
        rules = [TierRule("books", 6, 10), TierRule("books", 3, 5)]
        self.assertEqual(checkout(cart_with(("BK-003", 4)), OR, tier_rules=rules).tier_discount, 200)
        self.assertEqual(checkout(cart_with(("BK-003", 7)), OR, tier_rules=rules).tier_discount, 699)

    def test_empty_rules_disable_tiers(self):
        order = checkout(cart_with(("BK-003", 6)), OR, tier_rules=[])
        self.assertEqual(order.tier_discount, 0)
        self.assertEqual(order.total, 5994)

    def test_quantity_counts_across_lines_of_a_category(self):
        rules = [TierRule("electronics", 2, 20)]
        order = checkout(cart_with(("EL-001", 1), ("EL-002", 1), ("BK-001", 1)), OR, tier_rules=rules)
        self.assertEqual(order.tier_discount, 260 + 920)


class CouponStacking(unittest.TestCase):
    def test_second_percent_coupon_rejected(self):
        cart = cart_with(("EL-002", 1))
        cart.apply_coupon(Coupon("P10", "percent", 10))
        with self.assertRaises(CouponError):
            cart.apply_coupon(Coupon("P20", "percent", 20))
        self.assertEqual([c.code for c in cart.coupons], ["P10"])

    def test_same_code_twice_rejected(self):
        cart = cart_with(("EL-002", 1))
        cart.apply_coupon(Coupon("F5", "fixed", 500))
        with self.assertRaises(CouponError):
            cart.apply_coupon(Coupon("F5", "fixed", 500))
        self.assertEqual(len(cart.coupons), 1)

    def test_fixed_coupons_stack(self):
        cart = cart_with(("EL-002", 1))
        for code in ("A", "B", "C"):
            cart.apply_coupon(Coupon(code, "fixed", 100))
        cart.apply_coupon(Coupon("P", "percent", 5))
        self.assertEqual([c.code for c in cart.coupons], ["A", "B", "C", "P"])

    def test_exclusive_rules(self):
        cart = cart_with(("EL-002", 1))
        cart.apply_coupon(Coupon("F5", "fixed", 500))
        with self.assertRaises(CouponError):
            cart.apply_coupon(Coupon("SOLO", "percent", 25, exclusive=True))
        self.assertEqual([c.code for c in cart.coupons], ["F5"])
        cart.remove_coupon("F5")
        cart.apply_coupon(Coupon("SOLO", "percent", 25, exclusive=True))
        with self.assertRaises(CouponError):
            cart.apply_coupon(Coupon("F1", "fixed", 100))
        with self.assertRaises(CouponError):
            cart.apply_coupon(Coupon("SOLO2", "fixed", 100, exclusive=True))
        order = checkout(cart, OR)
        self.assertEqual(order.applied_coupons, [("SOLO", 1150)])

    def test_remove_and_clear(self):
        cart = cart_with(("EL-002", 1))
        with self.assertRaises(CouponError):
            cart.remove_coupon("NOPE")
        cart.apply_coupon(Coupon("A", "fixed", 100))
        cart.apply_coupon(Coupon("B", "fixed", 100))
        cart.remove_coupon("A")
        self.assertEqual([c.code for c in cart.coupons], ["B"])
        cart.clear_coupon()
        self.assertEqual(cart.coupons, [])
        self.assertEqual(checkout(cart, OR).coupon_discount, 0)

    def test_percent_applies_before_fixed(self):
        cart = cart_with(("EL-002", 1))
        cart.apply_coupon(Coupon("F5", "fixed", 500))
        cart.apply_coupon(Coupon("P10", "percent", 10))
        order = checkout(cart, OR)
        self.assertEqual(order.applied_coupons, [("P10", 460), ("F5", 500)])
        self.assertEqual(order.coupon_discount, 960)
        self.assertEqual(order.discount, 960)
        self.assertEqual(order.total, 4599 - 960 + 599)

    def test_minimum_checked_after_tiers(self):
        cart = cart_with(("BK-001", 3))          # 74.97, tier 5% -> 71.22
        cart.apply_coupon(Coupon("MIN72", "fixed", 1000, min_subtotal_cents=7200))
        cart.apply_coupon(Coupon("MIN71", "fixed", 300, min_subtotal_cents=7100))
        order = checkout(cart, OR)
        self.assertEqual(order.tier_discount, 375)
        self.assertEqual(order.rejected_coupons, ["MIN72"])
        self.assertEqual(order.applied_coupons, [("MIN71", 300)])
        self.assertEqual(order.discount, 675)

    def test_minimum_not_reduced_by_percent_coupon(self):
        cart = cart_with(("BK-001", 3))
        cart.apply_coupon(Coupon("P10", "percent", 10))
        cart.apply_coupon(Coupon("F70", "fixed", 200, min_subtotal_cents=7000))
        order = checkout(cart, OR)
        self.assertEqual(order.applied_coupons, [("P10", 712), ("F70", 200)])
        self.assertEqual(order.rejected_coupons, [])

    def test_fixed_coupons_capped_at_zero(self):
        cart = cart_with(("ST-002", 1))
        cart.apply_coupon(Coupon("F1", "fixed", 150))
        cart.apply_coupon(Coupon("F2", "fixed", 150))
        order = checkout(cart, CA)
        self.assertEqual(order.applied_coupons[0], ("F1", 150))
        self.assertEqual(sum(c for _, c in order.applied_coupons), 199)
        self.assertEqual((order.tax, order.shipping, order.total), (0, 0, 0))


class Totals(unittest.TestCase):
    def test_tax_on_merchandise_after_all_discounts(self):
        cart = cart_with(("BK-001", 3))
        cart.apply_coupon(Coupon("P10", "percent", 10))
        order = checkout(cart, CA)
        self.assertEqual((order.subtotal, order.tier_discount, order.coupon_discount), (7497, 375, 712))
        self.assertEqual(order.discount, 1087)
        self.assertEqual(order.tax, 465)
        self.assertEqual(order.shipping, 0)
        self.assertEqual(order.total, 6410 + 465)

    def test_shipping_threshold_after_discounts(self):
        cart = cart_with(("BK-001", 2), ("BK-003", 1))
        self.assertEqual(checkout(cart, OR).shipping, 0)
        cart.apply_coupon(Coupon("F8", "fixed", 800))
        order = checkout(cart, OR)
        self.assertEqual(order.shipping, 599)
        self.assertEqual(order.total, 5997 - 300 - 800 + 599)

    def test_receipt_lines(self):
        cart = cart_with(("BK-001", 3))
        cart.apply_coupon(Coupon("F2", "fixed", 200))
        cart.apply_coupon(Coupon("P10", "percent", 10))
        receipt = format_receipt(checkout(cart, CA))
        self.assertRegex(receipt, r"Tier discount\s+-3\.75")
        self.assertRegex(receipt, r"Coupon P10\s+-7\.12")
        self.assertRegex(receipt, r"Coupon F2\s+-2\.00")
        self.assertLess(receipt.index("Coupon P10"), receipt.index("Coupon F2"))
        self.assertRegex(receipt, r"Total\s+66\.60")

    def test_receipt_without_tier(self):
        cart = cart_with(("EL-001", 1))
        receipt = format_receipt(checkout(cart, OR))
        self.assertNotIn("Tier discount", receipt)
        self.assertNotIn("Coupon", receipt)


if __name__ == "__main__":
    unittest.main()
