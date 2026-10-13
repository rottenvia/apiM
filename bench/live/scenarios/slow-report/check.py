import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import csv, subprocess, time
c.passes("the tests pass", "-m", "unittest", "-q")
c.as_at_start(FILES, "make_export.py", "run.py", "test_dedupe.py")
NORM = "def ref_norm(email):\n    local, _, domain = email.strip().lower().partition('@')\n    local = local.split('+')[0]\n    if domain in ('gmail.com', 'googlemail.com'):\n        local, domain = local.replace('.', ''), 'gmail.com'\n    return local + '@' + domain\n"
SLOW = NORM + "import csv, subprocess, sys\nfrom dedupe import find_duplicates\ndef ref(records):\n    return [(i, j) for i in range(len(records)) for j in range(i + 1, len(records)) if ref_norm(records[i]['email']) == ref_norm(records[j]['email'])]\ndef made(rows, seed):\n    subprocess.run([sys.executable, 'make_export.py', str(rows), str(seed)], check=True)\n    return list(csv.DictReader(open('export.csv', newline='', encoding='utf-8')))\n"
c.cases("the same pairs as before, in order", SLOW, [("(lambda r: find_duplicates(r) == ref(r))(made(400, 5))", True), ("(lambda r: find_duplicates(r) == ref(r))(made(900, 11))", True), ("find_duplicates([])", []), ("find_duplicates([{'email': 'A.b+z@GoogleMail.com'}, {'email': 'x@y.z'}, {'email': ' ab@gmail.com'}])", [(0, 2)])], timeout=120)
FAST = NORM + "import csv, subprocess, sys, time\nfrom dedupe import find_duplicates\nsubprocess.run([sys.executable, 'make_export.py', '200000', '3'], check=True)\nrecords = list(csv.DictReader(open('export.csv', newline='', encoding='utf-8')))\ngroups = {}\nfor i, r in enumerate(records):\n    groups.setdefault(ref_norm(r['email']), []).append(i)\nwant = sorted((a, b) for m in groups.values() for n, a in enumerate(m) for b in m[n + 1:])\nstart = time.time()\ngot = find_duplicates(records)\ntook = time.time() - start\n"
c.cases("200,000 rows", FAST, [("took < 20", True), ("[tuple(p) for p in got] == want", True), ("len(want) > 5000", True)], timeout=150)

c.done()
