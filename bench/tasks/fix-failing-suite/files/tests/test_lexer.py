import unittest

from calc import CalcSyntaxError, tokenize


def kinds(src):
    return [t.kind for t in tokenize(src)]


def values(src):
    return [t.value for t in tokenize(src)][:-1]


class LexerTests(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(values("3 2.5 .5 10"), [3, 2.5, 0.5, 10])
        self.assertIsInstance(values("7")[0], int)
        self.assertIsInstance(values("7.0")[0], float)

    def test_names_and_punctuation(self):
        self.assertEqual(kinds("max(a_1, b)"), ["NAME", "LPAREN", "NAME", "COMMA", "NAME", "RPAREN", "EOF"])

    def test_operators(self):
        self.assertEqual(values("1+2*3/4%5^6"), [1, "+", 2, "*", 3, "/", 4, "%", 5, "^", 6])

    def test_positions(self):
        self.assertEqual([t.pos for t in tokenize("12 + x")], [0, 3, 5, 6])

    def test_minus_is_never_part_of_a_number(self):
        self.assertEqual(values("3 - -2"), [3, "-", "-", 2])
        self.assertEqual(kinds("-5"), ["OP", "NUM", "EOF"])

    def test_unexpected_character(self):
        with self.assertRaises(CalcSyntaxError) as cm:
            tokenize("1 + $")
        self.assertEqual(cm.exception.pos, 4)


if __name__ == "__main__":
    unittest.main()
