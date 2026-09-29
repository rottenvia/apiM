import unittest

from calc import Binary, CalcError, CalcSyntaxError, Name, Num, Unary, evaluate, parse, to_source, tokenize


class HiddenEvaluation(unittest.TestCase):
    def check(self, src, want, **env):
        with self.subTest(src=src):
            got = evaluate(src, **env)
            self.assertAlmostEqual(got, want, places=12)

    def test_subtraction_contexts(self):
        self.check("x-1", 4, x=5)
        self.check("x -1", 4, x=5)
        self.check("max(1,2)-3", -1)
        self.check("4 - -x", 5, x=1)
        self.check("(2)-(3)-1", -2)

    def test_unary_and_power(self):
        self.check("-2^-2", -0.25)
        self.check("2*-3", -6)
        self.check("-3^2*2", -18)
        self.check("-(2)^2", -4)
        self.check("(-2)^2", 4)
        self.check("2^-x^2", 0.5, x=1)
        self.check("2^3^0", 2)
        self.check("(2^3)^2", 64)
        self.check("---2", -2)
        self.check("-x^2", -9, x=3)

    def test_unary_binds_tighter_than_multiplicative(self):
        self.check("-x % 3", 2, x=1)
        self.check("-7 % 3", 2)
        self.check("1 - -2 * 3", 7)

    def test_errors_still_raised(self):
        for src in ["1 -", "-", "2^", "(-)", "1 2"]:
            with self.subTest(src=src), self.assertRaises(CalcSyntaxError):
                parse(src)
        with self.assertRaises(CalcError):
            evaluate("1 % 0")


class HiddenLexer(unittest.TestCase):
    def test_minus_tokens(self):
        for src in ["-1", "a-1", "(1)-2", "2^-1", "1--1"]:
            with self.subTest(src=src):
                toks = [t for t in tokenize(src) if t.kind == "NUM"]
                self.assertTrue(all(t.value >= 0 for t in toks))
        self.assertEqual([t.pos for t in tokenize("-12")], [0, 1, 3])


class HiddenParser(unittest.TestCase):
    def test_trees(self):
        self.assertEqual(parse("-2^2"), Unary("-", Binary("^", Num(2), Num(2))))
        self.assertEqual(parse("a^b^c^d"), Binary("^", Name("a"), Binary("^", Name("b"), Binary("^", Name("c"), Name("d")))))
        self.assertEqual(parse("-a*b"), Binary("*", Unary("-", Name("a")), Name("b")))
        self.assertEqual(parse("2^-1"), Binary("^", Num(2), Unary("-", Num(1))))
        self.assertEqual(parse("a-b-c"), Binary("-", Binary("-", Name("a"), Name("b")), Name("c")))
        self.assertEqual(parse("a/b/c"), Binary("/", Binary("/", Name("a"), Name("b")), Name("c")))


class HiddenPrinter(unittest.TestCase):
    CASES = {
        "a^(b^c)": "a^b^c",
        "(a^b)^c": "(a^b)^c",
        "-(2^2)": "-2^2",
        "(-x)^y": "(-x)^y",
        "-(a*b)": "-(a*b)",
        "-(-a)": "--a",
        "a*(-b)": "a*-b",
        "(-a)*b": "-a*b",
        "2^(-1)": "2^-1",
        "a-(b+c)": "a-(b+c)",
        "(a+b)-c": "a+b-c",
        "a/(b/c)": "a/(b/c)",
        "(a^b)^(c^d)": "(a^b)^c^d",
        "-(a^b)^c": "-(a^b)^c",
        "max(-a, b^c^d)": "max(-a,b^c^d)",
    }

    def test_exact_output(self):
        for src, want in self.CASES.items():
            with self.subTest(src=src):
                self.assertEqual(to_source(parse(src)), want)

    def test_reparses_to_same_tree(self):
        exprs = ["-a^-b^-c", "(a-b)^(c-d)", "-(a-b)*c", "a%(b%c)", "((-a)^b)^c", "-2^2^-1",
                 "a^-(b*c)", "(-(a))", "min(a,-b)^2", "a- -b - -c"]
        for src in exprs:
            with self.subTest(src=src):
                tree = parse(src)
                self.assertEqual(parse(to_source(tree)), tree)


if __name__ == "__main__":
    unittest.main()
