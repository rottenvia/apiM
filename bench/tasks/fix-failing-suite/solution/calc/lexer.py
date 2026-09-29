"""Turn source text into tokens."""
from __future__ import annotations

from dataclasses import dataclass

from .errors import CalcSyntaxError

OPERATORS = "+-*/%^"


@dataclass(frozen=True)
class Token:
    kind: str  # NUM, NAME, OP, LPAREN, RPAREN, COMMA, EOF
    value: object
    pos: int


def _starts_number(src: str, i: int) -> bool:
    return i < len(src) and (src[i].isdigit() or (src[i] == "." and i + 1 < len(src) and src[i + 1].isdigit()))


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch.isspace():
            i += 1
            continue
        start = i
        # '-' is always an operator; the parser decides unary vs binary.
        if _starts_number(src, i):
            seen_dot = False
            while i < n and (src[i].isdigit() or (src[i] == "." and not seen_dot)):
                seen_dot = seen_dot or src[i] == "."
                i += 1
            text = src[start:i]
            value = float(text) if seen_dot else int(text)
            tokens.append(Token("NUM", value, start))
            continue
        if ch.isalpha() or ch == "_":
            while i < n and (src[i].isalnum() or src[i] == "_"):
                i += 1
            tokens.append(Token("NAME", src[start:i], start))
            continue
        if ch in OPERATORS:
            tokens.append(Token("OP", ch, i))
        elif ch == "(":
            tokens.append(Token("LPAREN", ch, i))
        elif ch == ")":
            tokens.append(Token("RPAREN", ch, i))
        elif ch == ",":
            tokens.append(Token("COMMA", ch, i))
        else:
            raise CalcSyntaxError(f"unexpected character {ch!r}", i)
        i += 1
    tokens.append(Token("EOF", None, n))
    return tokens
