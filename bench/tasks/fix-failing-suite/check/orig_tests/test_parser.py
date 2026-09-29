import unittest

from calc import Binary, CalcSyntaxError, Call, Name, Num, Unary, parse


class ParserTests(unittest.TestCase):
    def test_precedence(self):
        self.assertEqual(parse("1+2*3"), Binary("+", Num(1), Binary("*", Num(2), Num(3))))

    def test_subtraction_is_left_associative(self):
        self.assertEqual(parse("1-2-3"), Binary("-", Binary("-", Num(1), Num(2)), Num(3)))

    def test_parentheses(self):
        self.assertEqual(parse("(1+2)*3"), Binary("*", Binary("+", Num(1), Num(2)), Num(3)))

    def test_call(self):
        self.assertEqual(parse("max(a, 2)"), Call("max", (Name("a"), Num(2))))

    def test_power_is_right_associative(self):
        self.assertEqual(parse("2^3^2"), Binary("^", Num(2), Binary("^", Num(3), Num(2))))

    def test_unary_minus_binds_looser_than_power(self):
        self.assertEqual(parse("-x^2"), Unary("-", Binary("^", Name("x"), Num(2))))

    def test_syntax_errors(self):
        for src in ["1+", "(1", "1 2", ")", "max(1,", ""]:
            with self.subTest(src=src), self.assertRaises(CalcSyntaxError):
                parse(src)


if __name__ == "__main__":
    unittest.main()
