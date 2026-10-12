import unittest

from shop import cart, hooks, orders, report


class ShopTest(unittest.TestCase):
    def test_cart(self):
        self.assertEqual(cart.summary([(250, 2), (999, 120)]), "2 lines, total 994.01")

    def test_orders(self):
        self.assertEqual(orders.describe(orders.discount({"id": 7, "cents": 2000}, 80)), "order 7: 10.00")

    def test_report(self):
        self.assertEqual(report.lines([{"id": 3, "cents": -105}]), ["   3      -1.05"])

    def test_formatter(self):
        self.assertEqual(hooks.formatter()(250), "2.50")
