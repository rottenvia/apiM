import unittest

from calc import CalcError, evaluate


class EvaluatorTests(unittest.TestCase):
    def test_arithmetic(self):
        self.assertEqual(evaluate("1 + 2 * 3"), 7)
        self.assertEqual(evaluate("10 / 4"), 2.5)
        self.assertEqual(evaluate("7 % 3"), 1)
        self.assertEqual(evaluate("1 - 2 - 3"), -4)

    def test_variables_and_functions(self):
        self.assertEqual(evaluate("max(a, b) * 2", a=3, b=5), 10)
        self.assertEqual(evaluate("abs(x) + sqrt(16)", x=-2), 6)

    def test_negative_exponent(self):
        self.assertEqual(evaluate("2^-1"), 0.5)

    def test_double_negation(self):
        self.assertEqual(evaluate("--3"), 3)

    def test_subtract_after_parenthesis(self):
        self.assertEqual(evaluate("(1+2)-3"), 0)

    def test_negated_power(self):
        self.assertEqual(evaluate("-2^2"), -4)

    def test_power_tower(self):
        self.assertEqual(evaluate("2^3^2"), 512)

    def test_errors(self):
        with self.assertRaises(CalcError):
            evaluate("1/0")
        with self.assertRaises(CalcError):
            evaluate("nope + 1")
        with self.assertRaises(CalcError):
            evaluate("frob(1)")


if __name__ == "__main__":
    unittest.main()
