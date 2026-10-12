import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import re
now, old = ("textutils", "utils") if c.turn == 1 else ("utils", "textutils")
c.row(f"shop/{now}.py is there", (c.ws / "shop" / f"{now}.py").is_file())
c.row(f"shop/{old}.py is gone", not (c.ws / "shop" / f"{old}.py").exists())
stale = re.compile(r"(?<!text)utils" if c.turn == 1 else r"textutils")
left = [p.relative_to(c.ws).as_posix() for p in c.ws.rglob("*") if p.is_file() and p.suffix in (".py", ".md", ".json", ".txt", ".cfg", ".toml") and not any(part.startswith(".") or part == "__pycache__" for part in p.relative_to(c.ws).parts) and stale.search(p.read_text("utf-8", "replace"))]
c.row(f"nothing names {old} any more", not left, left)
c.cases("shout", f"from shop.{now} import shout, money, clamp", [("shout('hi')", "HI!"), ("shout('Stop!')", "STOP!"), ("money(1234)", "12.34"), ("clamp(5, 0, 3)", 3)])
c.cases("the formatter named in settings loads", "from shop import hooks", [("hooks.formatter()(250)", "2.50")])
c.passes("the tests pass", "-m", "unittest", "-q")
if c.turn == 2:
    c.as_at_start(FILES, "shop/cart.py", "shop/orders.py", "shop/report.py", "shop/settings.py", "shop/hooks.py")
    c.row("README.md names shop/utils.py again", "`shop/utils.py`" in (c.ws / "README.md").read_text("utf-8"))

c.done()
