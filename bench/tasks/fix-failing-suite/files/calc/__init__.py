"""calc - a tiny, safe arithmetic expression language."""
from .errors import CalcError, CalcSyntaxError
from .evaluator import evaluate_tree
from .lexer import Token, tokenize
from .nodes import Binary, Call, Name, Num, Unary
from .parser import parse
from .printer import to_source


def evaluate(src: str, **variables):
    """Parse and evaluate `src` with the given variables."""
    return evaluate_tree(parse(src), variables)


__all__ = [
    "Binary", "CalcError", "CalcSyntaxError", "Call", "Name", "Num", "Token", "Unary",
    "evaluate", "evaluate_tree", "parse", "to_source", "tokenize",
]
