import unittest

from kit.wrap import wrap


class WrapTest(unittest.TestCase):
    def test_wrap(self):
        self.assertEqual(wrap('aaaa bbb', 7), ['aaaa', 'bbb'])
        self.assertEqual(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc'])
        self.assertEqual(wrap('one', 10), ['one'])
