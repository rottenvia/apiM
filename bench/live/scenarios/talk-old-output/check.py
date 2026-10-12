import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import ast, json, re
log = (c.ws / "runs.log").read_text("utf-8").splitlines() if (c.ws / "runs.log").exists() else []
c.row("stock.py was run exactly once", len(log) == 1, f"{len(log)} runs")
if c.turn == 1:
    said = (c.ws / "below.txt").read_text("utf-8") if (c.ws / "below.txt").exists() else ""
    c.row("below.txt holds the number", re.findall(r"\d+", said) == ["573"], said[:60])
if c.turn == 2:
    for path in sorted((c.ws / "lib").glob("*.py")):
        for fn in [n for n in ast.walk(ast.parse(path.read_text("utf-8"))) if isinstance(n, ast.FunctionDef)]:
            args = fn.args.posonlyargs + fn.args.args + fn.args.kwonlyargs
            c.row(f"{path.name} {fn.name}: hints and a docstring", all(a.annotation for a in args) and fn.returns is not None and ast.get_docstring(fn), "missing")
    c.passes("the tests pass", "-m", "unittest", "-q")
if c.turn == 3:
    def answer():
        got = json.loads((c.ws / "shortfall.json").read_text("utf-8"))
        want = {"warehouse": "WH-07", "sku": "SKU-66777", "shortfall": 119}
        return True if {k: got.get(k) for k in want} == want else f"got {got}, want {want}"
    c.test("shortfall.json is right", answer)

c.done()
