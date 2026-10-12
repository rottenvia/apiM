import unittest

from kit.titles import title_case


class TitlesTest(unittest.TestCase):
    def test_titles(self):
        self.assertEqual(title_case('the lord of the rings'), 'The Lord of the Rings')
        self.assertEqual(title_case('a tale of two cities'), 'A Tale of Two Cities')
        self.assertEqual(title_case('war and peace'), 'War and Peace')
