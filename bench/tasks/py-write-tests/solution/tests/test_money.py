import unittest
from decimal import Decimal

from money import allocate, format_cents, split, to_cents


class ToCentsTests(unittest.TestCase):
    def test_ints_are_whole_units(self):
        self.assertEqual(to_cents(5), 500)
        self.assertEqual(to_cents(0), 0)
        self.assertEqual(to_cents(-3), -300)

    def test_strings(self):
        self.assertEqual(to_cents("12.34"), 1234)
        self.assertEqual(to_cents("-$1,234.5"), -123450)
        self.assertEqual(to_cents("$1,000,000"), 100000000)
        self.assertEqual(to_cents("  7.1 "), 710)
        self.assertEqual(to_cents("0"), 0)

    def test_decimal(self):
        self.assertEqual(to_cents(Decimal("19.99")), 1999)
        self.assertEqual(to_cents(Decimal("-0.01")), -1)

    def test_rounds_half_to_even(self):
        self.assertEqual(to_cents("0.125"), 12)
        self.assertEqual(to_cents("0.135"), 14)
        self.assertEqual(to_cents("2.675"), 268)
        self.assertEqual(to_cents(Decimal("1.005")), 100)
        self.assertEqual(to_cents("-0.125"), -12)
        self.assertEqual(to_cents("-0.135"), -14)

    def test_rounds_to_nearest(self):
        self.assertEqual(to_cents("0.1249"), 12)
        self.assertEqual(to_cents("0.1251"), 13)
        self.assertEqual(to_cents("-0.1251"), -13)

    def test_bad_types(self):
        for bad in (1.5, True, None, [1]):
            with self.assertRaises(TypeError):
                to_cents(bad)

    def test_malformed(self):
        for bad in ("", "abc", "1.2.3", "1,23", "12,3456", "$-1", "--1", "1.", "Decimal", "1 000"):
            with self.assertRaises(ValueError, msg=bad):
                to_cents(bad)
        with self.assertRaises(ValueError):
            to_cents(Decimal("NaN"))
        with self.assertRaises(ValueError):
            to_cents(Decimal("Infinity"))


class FormatTests(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(format_cents(123456), "$1,234.56")
        self.assertEqual(format_cents(5), "$0.05")
        self.assertEqual(format_cents(0), "$0.00")
        self.assertEqual(format_cents(100000000), "$1,000,000.00")

    def test_negative(self):
        self.assertEqual(format_cents(-150), "-$1.50")
        self.assertEqual(format_cents(-5), "-$0.05")
        self.assertEqual(format_cents(-123456), "-$1,234.56")
        self.assertEqual(format_cents(-100), "-$1.00")

    def test_symbol(self):
        self.assertEqual(format_cents(250, ""), "2.50")
        self.assertEqual(format_cents(-250, "EUR "), "-EUR 2.50")

    def test_types(self):
        for bad in (1.0, "5", True):
            with self.assertRaises(TypeError):
                format_cents(bad)


class SplitTests(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(split(100, 3), [34, 33, 33])
        self.assertEqual(split(99, 3), [33, 33, 33])
        self.assertEqual(split(2, 5), [1, 1, 0, 0, 0])
        self.assertEqual(split(7, 1), [7])
        self.assertEqual(split(0, 2), [0, 0])

    def test_negative_is_mirror(self):
        self.assertEqual(split(-100, 3), [-34, -33, -33])
        for total in range(-50, 51):
            for parts in range(1, 7):
                self.assertEqual(split(-total, parts), [-x for x in split(total, parts)])

    def test_properties(self):
        for total in range(-40, 41):
            for parts in range(1, 9):
                s = split(total, parts)
                self.assertEqual(len(s), parts)
                self.assertEqual(sum(s), total)
                self.assertLessEqual(max(s) - min(s), 1)
                self.assertEqual(sorted(s, key=abs, reverse=True), s)

    def test_errors(self):
        with self.assertRaises(ValueError):
            split(10, 0)
        with self.assertRaises(ValueError):
            split(10, -1)
        with self.assertRaises(TypeError):
            split(10.0, 2)
        with self.assertRaises(TypeError):
            split(10, 2.0)


class AllocateTests(unittest.TestCase):
    def test_equal_weights_ties_go_first(self):
        self.assertEqual(allocate(100, [1, 1, 1]), [34, 33, 33])
        self.assertEqual(allocate(2, [1, 1, 1]), [1, 1, 0])

    def test_largest_remainder_not_largest_weight(self):
        # exact shares 4.375 and 2.625: the leftover cent goes to the second entry
        self.assertEqual(allocate(7, [5, 3]), [4, 3])
        self.assertEqual(allocate(10, [7, 2, 1]), [7, 2, 1])
        # 1.4, 2.1, 3.5 -> remainders .4 .1 .5
        self.assertEqual(allocate(7, [2, 3, 5]), [1, 2, 4])

    def test_decimal_weights_and_zero(self):
        self.assertEqual(allocate(10, [Decimal("0.5"), 0, Decimal("1.5")]), [3, 0, 7])

    def test_negative_is_mirror(self):
        self.assertEqual(allocate(-7, [5, 3]), [-4, -3])
        self.assertEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33])

    def test_sums(self):
        for total in range(-30, 31):
            for weights in ([1], [1, 2], [3, 3, 1], [0, 5, 7, 11]):
                self.assertEqual(sum(allocate(total, weights)), total)

    def test_errors(self):
        for bad in ([], [0, 0], [1, -1]):
            with self.assertRaises(ValueError):
                allocate(10, bad)
        with self.assertRaises(TypeError):
            allocate(10, [1.5])
        with self.assertRaises(TypeError):
            allocate(10.0, [1])


if __name__ == "__main__":
    unittest.main()
