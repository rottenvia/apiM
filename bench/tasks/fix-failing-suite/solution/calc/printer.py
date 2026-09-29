"""Render an AST back to source with minimal parentheses."""
from __future__ import annotations

from .nodes import Binary, Call, Name, Node, Num, Unary
from .parser import PRECEDENCE, RIGHT_ASSOC, UNARY_PREC

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
        if _prec(node.operand) < UNARY_PREC:
            inner = f"({inner})"
        return node.op + inner
    if isinstance(node, Binary):
        p = PRECEDENCE[node.op]
        left = to_source(node.left)
        right = to_source(node.right)
        right_assoc = node.op in RIGHT_ASSOC
        lp, rp = _prec(node.left), _prec(node.right)
        # left-associative: a-(b-c) needs parentheses, (a-b)-c does not;
        # right-associative (^): (a^b)^c needs them, a^(b^c) does not
        if lp < p or (lp == p and right_assoc):
            left = f"({left})"
        # a prefix minus can always start the right operand: a*-b, 2^-1
        if not isinstance(node.right, Unary) and (rp < p or (rp == p and not right_assoc)):
            right = f"({right})"
        return left + node.op + right
    raise TypeError(f"not a node: {node!r}")
