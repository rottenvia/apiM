import unittest

from shop.cart import Cart, CartError
from shop.catalog import UnknownProduct, demo_catalog


class CartTests(unittest.TestCase):
    def setUp(self):
        self.cart = Cart(demo_catalog())

    def test_add_accumulates(self):
        self.cart.add("BK-001")
        self.cart.add("BK-001", 2)
        self.assertEqual([(l.product.sku, l.qty) for l in self.cart.lines()], [("BK-001", 3)])

    def test_lines_keep_insertion_order(self):
        self.cart.add("ST-001")
        self.cart.add("BK-001")
        self.cart.add("ST-001")
        self.assertEqual([l.product.sku for l in self.cart.lines()], ["ST-001", "BK-001"])

    def test_bad_quantities(self):
        with self.assertRaises(CartError):
            self.cart.add("BK-001", 0)
        self.cart.add("BK-001", 99)
        with self.assertRaises(CartError):
            self.cart.add("BK-001")

    def test_unknown_product(self):
        with self.assertRaises(UnknownProduct):
            self.cart.add("NOPE")

    def test_set_qty_and_remove(self):
        self.cart.add("BK-001", 2)
        self.cart.add("ST-002")
        self.cart.set_qty("BK-001", 5)
        self.assertEqual(self.cart.lines()[0].qty, 5)
        self.cart.set_qty("BK-001", 0)
        self.assertEqual([l.product.sku for l in self.cart.lines()], ["ST-002"])
        self.cart.remove("ST-002")
        self.assertTrue(self.cart.is_empty())


if __name__ == "__main__":
    unittest.main()
