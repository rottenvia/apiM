"""Evaluate an AST."""
from __future__ import annotations

import math

from .errors import CalcError
from .nodes import Binary, Call, Name, Node, Num, Unary

FUNCTIONS = {
    "abs": (abs, 1, 1),
    "min": (min, 1, None),
    "max": (max, 1, None),
    "sqrt": (math.sqrt, 1, 1),
    "round": (round, 1, 2),
}


def _binary(op, a, b):
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op in "/%" and b == 0:
        raise CalcError("division by zero")
    if op == "/":
        return a / b
    if op == "%":
        return a % b
    if op == "^":
        try:
            return a ** b
        except (OverflowError, ZeroDivisionError) as e:
            raise CalcError(str(e)) from None
    raise CalcError(f"unknown operator {op!r}")


def evaluate_tree(node: Node, variables: dict | None = None):
    variables = variables or {}
    if isinstance(node, Num):
        return node.value
    if isinstance(node, Name):
        try:
            return variables[node.id]
        except KeyError:
            raise CalcError(f"unknown variable {node.id!r}") from None
    if isinstance(node, Unary):
        return -evaluate_tree(node.operand, variables)
    if isinstance(node, Binary):
        return _binary(node.op, evaluate_tree(node.left, variables), evaluate_tree(node.right, variables))
    if isinstance(node, Call):
        if node.func not in FUNCTIONS:
            raise CalcError(f"unknown function {node.func!r}")
        fn, lo, hi = FUNCTIONS[node.func]
        if len(node.args) < lo or (hi is not None and len(node.args) > hi):
            raise CalcError(f"{node.func}() takes {lo}..{hi or 'n'} arguments")
        args = [evaluate_tree(a, variables) for a in node.args]
        try:
            return fn(*args)
        except (TypeError, ValueError) as e:
            raise CalcError(str(e)) from None
    raise CalcError(f"cannot evaluate {node!r}")
