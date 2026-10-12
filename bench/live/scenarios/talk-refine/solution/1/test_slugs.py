import unittest
from slugs import slugify


class SlugTest(unittest.TestCase):
    def test_words(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_edges(self):
        self.assertEqual(slugify("  --A  b__c "), "a-b-c")

    def test_empty(self):
        self.assertEqual(slugify("!!!"), "untitled")
