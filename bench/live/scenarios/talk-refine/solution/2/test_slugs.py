import unittest
from slugs import slugify, unique_slug


class SlugTest(unittest.TestCase):
    def test_words(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_edges(self):
        self.assertEqual(slugify("  --A  b__c "), "a-b-c")

    def test_empty(self):
        self.assertEqual(slugify("!!!"), "untitled")

    def test_unique(self):
        self.assertEqual(unique_slug("Hello World", {"hello-world"}), "hello-world-2")
