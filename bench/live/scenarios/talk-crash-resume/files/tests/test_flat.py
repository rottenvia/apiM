import unittest

from kit.flat import flatten


class FlatTest(unittest.TestCase):
    def test_flat(self):
        self.assertEqual(flatten([1, [2, [3]]]), [1, 2, 3])
        self.assertEqual(flatten([[1, 2], [3]]), [1, 2, 3])
        self.assertEqual(flatten([[[['x']]]]), ['x'])
