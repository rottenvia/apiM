import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import re
c.row("rule 1: payments/ops/refund.py", (c.ws / "payments/ops/refund.py").is_file())
setup = "from payments.ops import REGISTRY, capture, charge\nfrom payments.errors import PaymentError, InvalidAmount, InvalidState\nfrom payments.ops.refund import refund\npaid = capture(charge('ann', 1000))\nonce = refund(paid, 300)"
c.cases("refund", setup, [
    ("REGISTRY.get('refund') is refund", True),
    ("once['refunded_cents']", 300),
    ("paid['refunded_cents']", 0),
    ("refund(once, 700)['refunded_cents']", 1000),
    ("raises(lambda: refund(once, 701), InvalidAmount)", True),
    ("raises(lambda: refund(charge('ann', 1000), 100), InvalidState)", True),
    ("raises(lambda: refund(paid, 0), InvalidAmount)", True),
    ("raises(lambda: refund(paid, -5), InvalidAmount)", True),
    ("raises(lambda: refund(paid, 10.5), InvalidAmount)", True),
])
log = (c.ws / "CHANGELOG.md").read_text("utf-8") if (c.ws / "CHANGELOG.md").exists() else ""
unreleased = log.split("## Unreleased", 1)[-1].split("\n## ", 1)[0] if "## Unreleased" in log else ""
c.row("rule 6: a line about refund under Unreleased", "refund" in unreleased.lower() and "captured in part" in unreleased, unreleased[:120])
tests = (c.ws / "tests/test_refund.py").read_text("utf-8") if (c.ws / "tests/test_refund.py").exists() else ""
c.row("rule 5: tests/test_refund.py with at least three tests", tests.count("def test") >= 3, tests.count("def test"))
c.passes("all tests pass", "-m", "unittest", "-q")

c.done()
