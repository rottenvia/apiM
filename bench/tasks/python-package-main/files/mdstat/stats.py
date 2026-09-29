"""Counting functions. All of them take the full document text."""
from __future__ import annotations

import re
from dataclasses import dataclass, asdict

_FENCE = re.compile(r"^(```|~~~)")
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_LINK = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_WORD = re.compile(r"[^\W_]+(?:['’-][^\W_]+)*")


def _split_prose_and_code(text: str) -> tuple[list[str], list[list[str]]]:
    """Return (prose lines, list of fenced code blocks as line lists)."""
    prose: list[str] = []
    blocks: list[list[str]] = []
    current: list[str] | None = None
    fence = ""
    for line in text.splitlines():
        m = _FENCE.match(line.lstrip())
        if current is None:
            if m:
                fence = m.group(1)
                current = []
            else:
                prose.append(line)
        else:
            if line.strip().startswith(fence) and line.strip().strip(fence[0]) == "":
                blocks.append(current)
                current = None
            else:
                current.append(line)
    if current is not None:  # unterminated fence runs to end of document
        blocks.append(current)
    return prose, blocks


def count_lines(text: str) -> int:
    """Number of lines. A trailing newline does not start a new line."""
    return len(text.splitlines())


def count_words(text: str) -> int:
    """Words in prose, i.e. outside fenced code blocks. Markup is not a word."""
    prose, _ = _split_prose_and_code(text)
    total = 0
    for line in prose:
        line = _LINK.sub(lambda m: m.group(1), line)
        total += len(_WORD.findall(line))
    return total


def headings(text: str) -> list[tuple[int, str]]:
    """ATX headings outside code blocks as (level, title) pairs."""
    prose, _ = _split_prose_and_code(text)
    out = []
    for line in prose:
        m = _HEADING.match(line)
        if m:
            out.append((len(m.group(1)), m.group(2)))
    return out


def code_blocks(text: str) -> list[str]:
    """Bodies of fenced code blocks."""
    _, blocks = _split_prose_and_code(text)
    return ["\n".join(b) for b in blocks]


def links(text: str) -> list[str]:
    """Targets of inline links (not images) outside code blocks."""
    prose, _ = _split_prose_and_code(text)
    out = []
    for line in prose:
        out.extend(m.group(2) for m in _LINK.finditer(line))
    return out


@dataclass(frozen=True)
class Stats:
    lines: int
    words: int
    headings: int
    code_blocks: int
    links: int

    def as_dict(self) -> dict:
        return asdict(self)


def analyze(text: str) -> Stats:
    return Stats(
        lines=count_lines(text),
        words=count_words(text),
        headings=len(headings(text)),
        code_blocks=len(code_blocks(text)),
        links=len(links(text)),
    )
