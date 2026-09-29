import unittest

from calc import parse, to_source, evaluate


def rt(src):
    return to_source(parse(src))


class PrinterTests(unittest.TestCase):
    def test_minimal_parentheses(self):
        self.assertEqual(rt("1 + 2 * 3"), "1+2*3")
        self.assertEqual(rt("(1 + 2) * 3"), "(1+2)*3")
        self.assertEqual(rt("((a))"), "a")

    def test_left_associative_operators(self):
        self.assertEqual(rt("(a-b)-c"), "a-b-c")
        self.assertEqual(rt("1-(2-3)"), "1-(2-3)")
        self.assertEqual(rt("a/(b*c)"), "a/(b*c)")

    def test_power_chain(self):
        self.assertEqual(rt("2^3^2"), "2^3^2")

    def test_parenthesised_power_base(self):
        self.assertEqual(rt("(2^3)^2"), "(2^3)^2")

    def test_negated_power(self):
        self.assertEqual(rt("-2^2"), "-2^2")

    def test_negative_exponent(self):
        self.assertEqual(rt("2^-1"), "2^-1")

    def test_negative_base(self):
        self.assertEqual(rt("(-2)^2"), "(-2)^2")

    def test_calls_and_floats(self):
        self.assertEqual(rt("max(1, 2.5) * 3.0"), "max(1,2.5)*3.0")

    def test_round_trip_keeps_value(self):
        for src in ["2^3^2", "-2^2", "2^-1", "a-(b-c)", "(a+b)*c", "-(a*b)", "10%4*2"]:
            with self.subTest(src=src):
                env = dict(a=5, b=3, c=2)
                self.assertEqual(evaluate(rt(src), **env), evaluate(src, **env))


if __name__ == "__main__":
    unittest.main()
