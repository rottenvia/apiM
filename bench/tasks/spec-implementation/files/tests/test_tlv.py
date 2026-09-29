import unittest

from tlv import TLVError, decode, encode

EXAMPLE = bytes.fromhex("b71e01010f81026869a2064001014001ff3f280187c2")


class SpecExampleTests(unittest.TestCase):
    def test_encode_example(self):
        self.assertEqual(encode({1: "hi", 2: [1, -1], 40: True}), EXAMPLE)

    def test_decode_example(self):
        self.assertEqual(decode(EXAMPLE), {1: "hi", 2: [1, -1], 40: True})

    def test_bad_magic(self):
        with self.assertRaises(TLVError):
            decode(b"\x00" + EXAMPLE[1:])


if __name__ == "__main__":
    unittest.main()
