"""Precedence-climbing parser: tokens -> AST."""
from __future__ import annotations

from .errors import CalcSyntaxError
from .lexer import Token, tokenize
from .nodes import Binary, Call, Name, Node, Num, Unary

# binding power of each binary operator (higher binds tighter)
PRECEDENCE = {
    "+": 10, "-": 10,
    "*": 20, "/": 20, "%": 20,
    "^": 30,
}
RIGHT_ASSOC = {"^"}
UNARY_PREC = 25  # tighter than * / %, looser than ^


class _Parser:
    def __init__(self, tokens: list[Token]):
        self.tokens = tokens
        self.i = 0

    @property
    def tok(self) -> Token:
        return self.tokens[self.i]

    def advance(self) -> Token:
        t = self.tokens[self.i]
        self.i += 1
        return t

    def expect(self, kind: str) -> Token:
        if self.tok.kind != kind:
            raise CalcSyntaxError(f"expected {kind}, found {self.tok.value!r}", self.tok.pos)
        return self.advance()

    def expression(self, min_prec: int = 0) -> Node:
        left = self.prefix()
        while self.tok.kind == "OP" and PRECEDENCE[self.tok.value] >= min_prec:
            op = self.advance().value
            prec = PRECEDENCE[op]
            right = self.expression(prec if op in RIGHT_ASSOC else prec + 1)
            left = Binary(op, left, right)
        return left

    def prefix(self) -> Node:
        t = self.tok
        if t.kind == "OP" and t.value == "-":
            self.advance()
            return Unary("-", self.expression(UNARY_PREC))
        if t.kind == "NUM":
            self.advance()
            return Num(t.value)
        if t.kind == "NAME":
            self.advance()
            if self.tok.kind == "LPAREN":
                self.advance()
                args = []
                if self.tok.kind != "RPAREN":
                    args.append(self.expression())
                    while self.tok.kind == "COMMA":
                        self.advance()
                        args.append(self.expression())
                self.expect("RPAREN")
                return Call(t.value, tuple(args))
            return Name(t.value)
        if t.kind == "LPAREN":
            self.advance()
            inner = self.expression()
            self.expect("RPAREN")
            return inner
        what = "end of input" if t.kind == "EOF" else repr(t.value)
        raise CalcSyntaxError(f"unexpected {what}", t.pos)


def parse(src: str) -> Node:
    p = _Parser(tokenize(src))
    tree = p.expression()
    if p.tok.kind != "EOF":
        raise CalcSyntaxError(f"unexpected {p.tok.value!r}", p.tok.pos)
    return tree
