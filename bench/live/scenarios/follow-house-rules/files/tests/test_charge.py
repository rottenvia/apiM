import unittest

from payments.errors import InvalidAmount
from payments.ops import charge


class ChargeTest(unittest.TestCase):
    def test_charge(self):
        self.assertEqual(charge("ann", 500)["state"], "authorised")

    def test_refuses_fractions(self):
        self.assertRaises(InvalidAmount, charge, "ann", 4.5)
