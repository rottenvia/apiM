import unittest

from dedupe import find_duplicates, norm


class Dedupe(unittest.TestCase):
    def test_norm(self):
        self.assertEqual(norm(" Ann.Lee+shop@GoogleMail.com"), "annlee@gmail.com")
        self.assertEqual(norm("ann.lee@example.org"), "ann.lee@example.org")

    def test_pairs(self):
        records = [{"email": e} for e in ["a@x.org", "b@x.org", "A@x.org", "b+1@x.org", "a@x.org"]]
        self.assertEqual(find_duplicates(records), [(0, 2), (0, 4), (1, 3), (2, 4)])


if __name__ == "__main__":
    unittest.main()
