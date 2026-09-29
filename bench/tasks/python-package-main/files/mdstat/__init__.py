"""mdstat - quick statistics for Markdown documents.

Library usage:

    from mdstat import analyze
    stats = analyze(open("README.md", encoding="utf-8").read())
    stats.words, stats.headings, ...
"""
from .stats import (
    Stats,
    analyze,
    code_blocks,
    count_lines,
    count_words,
    headings,
    links,
)

__all__ = [
    "Stats",
    "analyze",
    "code_blocks",
    "count_lines",
    "count_words",
    "headings",
    "links",
]
__version__ = "0.3.0"
