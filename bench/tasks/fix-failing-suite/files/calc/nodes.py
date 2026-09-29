"""AST node types. Nodes are immutable and compare by value."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Union


@dataclass(frozen=True)
class Num:
    value: float


@dataclass(frozen=True)
class Name:
    id: str


@dataclass(frozen=True)
class Unary:
    op: str
    operand: "Node"


@dataclass(frozen=True)
class Binary:
    op: str
    left: "Node"
    right: "Node"


@dataclass(frozen=True)
class Call:
    func: str
    args: tuple


Node = Union[Num, Name, Unary, Binary, Call]
