import unittest

import money


class MoneyTests(unittest.TestCase):
    def test_to_cents(self):
        self.assertEqual(money.to_cents("1.50"), 150)


if __name__ == "__main__":
    unittest.main()
