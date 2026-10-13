import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

c.passes("the tests pass", "-m", "unittest", "-q")
c.as_at_start(FILES, "data/orders-2026-03.csv", "run_report.py")
code, out, err = c.python("run_report.py")
c.row("the report prints accounting's total", out.strip().endswith("total 34299.98"), (out or err)[-200:])
c.row("and the regions", all(line in out for line in ['north 9075.60', 'south 8778.03', 'east 6816.78', 'west 9629.57']), out[-300:])
c.cases("to_cents", "from shopkit.util.money import to_cents\nfrom shopkit.billing.compat import parse_amount\nfrom shopkit.pricing.discounts import apply", [
    ("to_cents('7.5')", 750), ("to_cents('0.5')", 50), ("to_cents('3')", 300), ("to_cents('10.05')", 1005), ("to_cents(' 2.30 ')", 230), ("to_cents('12.50')", 1250), ("to_cents('129.9')", 12990),
    ("parse_amount('4.5')", 450), ("apply(1005, 'TEN')", 904), ("apply(999, 'QUARTER')", 749), ("apply(1250, '')", 1250),
])

c.done()
