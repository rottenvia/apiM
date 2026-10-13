import unittest
import tally


class T(unittest.TestCase):
    def test_minutes(self):
        self.assertEqual(tally.minutes('1.5h'), 90)


if __name__ == '__main__':
    unittest.main()
