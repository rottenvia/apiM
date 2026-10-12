import unittest

from payments.errors import InvalidAmount, InvalidState
from payments.ops import capture, charge


class CaptureTest(unittest.TestCase):
    def test_partial(self):
        payment = charge("ann", 500)
        self.assertEqual(capture(payment, 200)["captured_cents"], 200)
        self.assertEqual(payment["state"], "authorised")

    def test_twice(self):
        self.assertRaises(InvalidState, capture, capture(charge("ann", 500)))

    def test_too_much(self):
        self.assertRaises(InvalidAmount, capture, charge("ann", 500), 501)
