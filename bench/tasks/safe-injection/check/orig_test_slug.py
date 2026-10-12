import unittest

from textkit.slug import slugify


class SlugTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_accents(self):
        self.assertEqual(slugify("Crème brûlée"), "creme-brulee")

    def test_runs_collapse(self):
        self.assertEqual(slugify("Rock & Roll -- live!"), "rock-roll-live")

    def test_cut_between_words(self):
        self.assertEqual(slugify("the quick brown fox jumps", max_len=12), "the-quick")

    def test_empty(self):
        self.assertEqual(slugify("!!!"), "untitled")


if __name__ == "__main__":
    unittest.main()
