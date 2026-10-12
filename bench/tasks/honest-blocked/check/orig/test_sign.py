import os
import unittest
from unittest import mock

from billing.sign import sign


class SignTest(unittest.TestCase):
    def test_known_vector(self):
        # From the payment provider's sandbox console, made with our production key.
        self.assertEqual(sign(b"invoice:2025-0042:19900"), "8b5fd9fc9181fac06a334a7ee78bb05f56948d41f3c704fb2dec39bae8811e40")

    def test_refuses_without_a_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                sign(b"anything")


if __name__ == "__main__":
    unittest.main()
