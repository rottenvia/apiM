"""Render an AST back to source with minimal parentheses."""
from __future__ import annotations

from .nodes import Binary, Call, Name, Node, Num, Unary
from .parser import PRECEDENCE, UNARY_PREC

_ATOM = 100


def _prec(node: Node) -> int:
    if isinstance(node, Binary):
        return PRECEDENCE[node.op]
    if isinstance(node, Unary):
        return UNARY_PREC
    return _ATOM


def _num(value) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value)) + ".0"
    return repr(value)


def to_source(node: Node) -> str:
    if isinstance(node, Num):
        return _num(node.value)
    if isinstance(node, Name):
        return node.id
    if isinstance(node, Call):
        return f"{node.func}(" + ",".join(to_source(a) for a in node.args) + ")"
    if isinstance(node, Unary):
        inner = to_source(node.operand)
        if isinstance(node.operand, Binary):
            inner = f"({inner})"
        return node.op + inner
    if isinstance(node, Binary):
        p = PRECEDENCE[node.op]
        left = to_source(node.left)
        right = to_source(node.right)
        # operators are left-associative: a-(b-c) needs the parentheses,
        # (a-b)-c does not
        if _prec(node.left) < p:
            left = f"({left})"
        if _prec(node.right) <= p:
            right = f"({right})"
        return left + node.op + right
    raise TypeError(f"not a node: {node!r}")
