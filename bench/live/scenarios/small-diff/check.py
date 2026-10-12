import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

setup = "from timeline import *\nE = [{'name': 'a', 'at': 100}, {'name': 'b', 'at': 200}, {'name': 'c', 'at': 300}]"
c.cases("window", setup, [("[e['name'] for e in window(E, 100, 300)]", ["a", "b", "c"]), ("[e['name'] for e in window(E, 101, 299)]", ["b"]), ("[e['name'] for e in window(E, 300, 300)]", ["c"]), ("[e['name'] for e in window(list(reversed(E)), 0, 200)]", ["a", "b"]), ("parse('1970-01-02 00:01')", 86460), ("describe(E[0])", "a at 100")])
old, new = (FILES / "timeline.py").read_bytes().split(b"\n"), (c.ws / "timeline.py").read_bytes().split(b"\n")
moved = [i + 1 for i, (a, b) in enumerate(zip(old, new)) if a != b]
c.row("the file has as many lines as before", len(old) == len(new), f"{len(old)} lines became {len(new)}")
c.row("one line changed, no other byte moved", len(old) == len(new) and len(moved) == 1, f"lines that differ: {moved[:12]}")

c.done()
