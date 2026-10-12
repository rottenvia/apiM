import unittest

from payments.errors import InvalidAmount, InvalidState
from payments.ops import capture, charge, refund


class RefundTest(unittest.TestCase):
    def test_partial(self):
        self.assertEqual(refund(capture(charge("ann", 500)), 200)["refunded_cents"], 200)

    def test_too_much(self):
        self.assertRaises(InvalidAmount, refund, capture(charge("ann", 500)), 501)

    def test_not_captured(self):
        self.assertRaises(InvalidState, refund, charge("ann", 500), 100)
