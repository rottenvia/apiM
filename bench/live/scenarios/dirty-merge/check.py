import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import csv, io
EXPECTED = [['ann.lee@example.org', 'Ann Lee', '0301234567', '2024-04-01'], ['bo@example.org', 'Bo Berg', '+15550100', '2023-01-15'], ['carla.diaz@example.org', 'Diaz, Carla', '+491512345678', '2022-02-28'], ['dmitri@example.org', 'Dmitri Orlov', '84951234567', '2020-07-19'], ['ed@example.org', 'Ed Van Dyke', '', '2024-12-12'], ['fay@example.org', 'Wong', '', '2025-05-05'], ['gus@example.org', 'Gus Hall', '5550199', ''], ['lukasz@example.org', 'Łukasz Żak', '+48600700800', '2025-06-30'], ['zoe@example.org', 'Zoë Müller', '01715550101', '2021-11-09']]
data = (c.ws / "people.csv").read_bytes() if (c.ws / "people.csv").exists() else b""
c.row("people.csv has no byte order mark", data and not data.startswith(b"\xef\xbb\xbf"))
c.row("line ends are \\n", data and b"\r" not in data)
try:
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
except Exception as e:
    rows = []
c.row("the header", rows[:1] == [["email", "name", "phone", "signup"]], rows[:1])
body = [r for r in rows[1:] if r]
c.row("one row per person, sorted by email", [r[0] for r in body if r] == [r[0] for r in EXPECTED], [r[0] for r in body if r])
found = {r[0]: r for r in body if r}
for want in EXPECTED:
    c.row(f"{want[0]}", found.get(want[0]) == want, f"got {found.get(want[0])}, want {want}")

c.done()
