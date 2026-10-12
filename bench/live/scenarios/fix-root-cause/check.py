import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

c.passes("the tests pass", "-m", "unittest", "-q")
c.as_at_start(FILES, "tests/test_report.py")
setup = "from ledger import report, store\nstore.reset()\nstore.open_account('alice'); store.open_account('bob')\nstore.post('alice', 5000, 'salary'); store.post('bob', 1200, 'gift')\nstore.transfer('alice', 'bob', 300)"
c.cases("two accounts", setup, [
    ("len(store.get('alice')['entries'])", 2),
    ("[e['cents'] for e in store.get('bob')['entries']]", [1200, 300]),
    ("report.statement('bob')", ["gift: 12.00", "from alice: 3.00", "balance: 15.00"]),
    ("report.balance('alice')", 4700),
    ("store.open_account('carol')['entries']", []),
])
c.cases("after a reset", setup + "\nstore.reset()\nfresh = store.open_account('dave')", [("len(fresh['entries'])", 0), ("store.post('dave', 5) or report.balance('dave')", 5)])
c.cases("opening entries are kept", "from ledger import report, store\nstore.reset()\nstore.open_account('erin', [{'account': 'erin', 'cents': 700, 'memo': 'opening'}])", [("report.statement('erin')", ["opening: 7.00", "balance: 7.00"])])

c.done()
