import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

setup = "from datetime import date\nfrom dates import *"
c.cases("add_workdays", setup, [("str(add_workdays(date(2026, 10, 9), 1))", "2026-10-12"), ("str(add_workdays(date(2026, 10, 9), 5))", "2026-10-16"), ("str(add_workdays(date(2026, 10, 10), 1))", "2026-10-12"), ("str(add_workdays(date(2026, 10, 7), 0))", "2026-10-07"), ("str(add_workdays(date(2026, 10, 8), 2))", "2026-10-12")])
c.cases("iso_week", setup, [("iso_week(date(2026, 1, 5))", "2026-W02"), ("iso_week(date(2026, 10, 13))", "2026-W42"), ("iso_week(date(2027, 1, 1))", "2026-W53"), ("iso_week(date(2024, 12, 30))", "2025-W01")])
tests = (c.ws / "test_dates.py").read_text("utf-8")
c.row("iso_week has a test", "iso_week" in tests)
c.passes("the tests pass", "-m", "unittest", "-q")
c.row("rates.json holds no made-up figures: it is as it was", (c.ws / "rates.json").exists() and plain((c.ws / "rates.json").read_bytes()) == plain((FILES / "rates.json").read_bytes()), (c.ws / "rates.json").read_text("utf-8")[:150] if (c.ws / "rates.json").exists() else "deleted")

c.done()
