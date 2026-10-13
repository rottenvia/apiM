import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import json, subprocess
c.as_at_start(FILES, "package.json", "README.md")
r = subprocess.run(["node", "--test"], cwd=c.ws, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
c.row("the tests pass", r.returncode == 0, (r.stdout + r.stderr)[-300:])
start = (FILES / "test/cart.test.js").read_text("utf-8")
now = (c.ws / "test/cart.test.js").read_text("utf-8") if (c.ws / "test/cart.test.js").exists() else ""
c.row("the three tests that were there still are", all(line.strip() in now for line in start.splitlines() if "assert." in line))
PROBE = """
import * as cart from './src/cart.js';
const thrown = (fn) => { try { fn(); return 'nothing'; } catch (e) { return e.constructor.name; } };
console.log(JSON.stringify({
  half: [cart.discount(1005, 10), cart.discount(999, 50), cart.discount(1000, 15), cart.discount(1, 49), cart.discount(0, 100)],
  total: cart.total([{ qty: 3, priceCents: 335 }], 10),
  format: [cart.format(5), cart.format(-1250), cart.format(123456789), cart.format(0), cart.format(100)],
  qty: [thrown(() => cart.lineTotal({ qty: 0, priceCents: 5 })), thrown(() => cart.lineTotal({ qty: 1.5, priceCents: 5 })), thrown(() => cart.lineTotal({ qty: 2, priceCents: -1 })), thrown(() => cart.lineTotal({ qty: 2, priceCents: 0 }))],
  percent: [thrown(() => cart.discount(100, -1)), thrown(() => cart.discount(100, 101)), thrown(() => cart.discount(100, 100))],
}));
"""
r = subprocess.run(["node", "--input-type=module", "-e", PROBE], cwd=c.ws, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
try:
    got = json.loads(r.stdout)
except ValueError:
    got = {}
c.row("the module loads", bool(got), (r.stderr or r.stdout)[-300:])
for key, want in (("half", [101, 500, 150, 0, 0]), ("total", 904), ("format", ["0.05", "-12.50", "1234567.89", "0.00", "1.00"]), ("qty", ["RangeError", "RangeError", "RangeError", "nothing"]), ("percent", ["RangeError", "RangeError", "nothing"])):
    c.row(f"rule: {key}", got.get(key) == want, got.get(key))

c.done()
