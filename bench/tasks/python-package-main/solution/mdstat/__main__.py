"""Command-line entry point: python -m mdstat FILE [FILE ...]"""
from __future__ import annotations

import argparse
import json
import sys

from .stats import analyze


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mdstat", description="Statistics for Markdown files.")
    p.add_argument("files", nargs="+", metavar="FILE", help="Markdown file, or - for standard input")
    p.add_argument("--json", action="store_true", help="print a JSON array instead of text")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    results = []
    failed = False
    for path in args.files:
        if path == "-":
            name, text = "<stdin>", sys.stdin.read()
        else:
            name = path
            try:
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
            except (OSError, UnicodeDecodeError) as exc:
                reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else str(exc)
                print(f"mdstat: cannot read {path}: {reason}", file=sys.stderr)
                failed = True
                continue
        results.append({"file": name, **analyze(text).as_dict()})

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        blocks = []
        for r in results:
            lines = [f"== {r['file']} =="]
            lines += [f"{k}: {r[k]}" for k in ("lines", "words", "headings", "code_blocks", "links")]
            blocks.append("\n".join(lines))
        if blocks:
            print("\n\n".join(blocks))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
