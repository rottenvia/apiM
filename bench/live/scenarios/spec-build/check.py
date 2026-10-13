import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import csv, io, shutil, tempfile
box = c.ws / "_box"
shutil.rmtree(box, ignore_errors=True)
box.mkdir()
def t(*args):
    r = c.run(sys.executable, str(c.ws / "tally.py"), *args) if False else None
import subprocess
def t(*args):
    r = subprocess.run([sys.executable, str(c.ws / "tally.py"), *args], cwd=box, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    return r.returncode, r.stdout.replace("\r\n", "\n").rstrip("\n"), r.stderr.strip()
def want(name, got, code, out=None):
    c.row(name, got[0] == code and (out is None or got[1] == out) and (code == 0 or (got[2].startswith("error: ") and "\n" not in got[2])), got)
c.row("tally.py and test_tally.py are there", (c.ws / "tally.py").is_file() and (c.ws / "test_tally.py").is_file())
want("list with nothing logged", t("list"), 0, "nothing logged")
want("add prints the id", t("add", "90m", "write report", "--date", "2026-03-02", "--tag", "Docs", "--tag", "docs", "--tag", "admin"), 0, "added 1")
want("1h30m", t("add", "1h30m", "review", "--date", "2026-03-01"), 0, "added 2")
want("1.5h", t("add", "1.5h", "plan sprint", "--date", "2026-03-02", "--tag", "admin"), 0, "added 3")
want("2h", t("add", "2h", "deep work", "--date", "2026-03-05", "--tag", "code"), 0, "added 4")
want("5 minutes", t("add", "5m", "standup", "--date", "2026-03-05"), 0, "added 5")
want("the list, by date then id, tags lower case once sorted", t("list"), 0, "2  2026-03-01  1:30  review\n1  2026-03-02  1:30  write report  [admin,docs]\n3  2026-03-02  1:30  plan sprint  [admin]\n4  2026-03-05  2:00  deep work  [code]\n5  2026-03-05  0:05  standup")
want("from and to include their day", t("list", "--from", "2026-03-02", "--to", "2026-03-02"), 0, "1  2026-03-02  1:30  write report  [admin,docs]\n3  2026-03-02  1:30  plan sprint  [admin]")
want("a tag in any case", t("list", "--tag", "ADMIN"), 0, "1  2026-03-02  1:30  write report  [admin,docs]\n3  2026-03-02  1:30  plan sprint  [admin]")
want("a filter that leaves nothing", t("list", "--from", "2027-01-01"), 0, "nothing logged")
want("sum", t("sum"), 0, "total 6:35")
want("sum by tag: both tags, (none) last, total once", t("sum", "--by", "tag"), 0, "admin 3:00\ncode 2:00\ndocs 1:30\n(none) 1:35\ntotal 6:35")
want("sum by date", t("sum", "--by", "date", "--to", "2026-03-02"), 0, "2026-03-01 1:30\n2026-03-02 3:00\ntotal 4:30")
before = (box / "tally.json").read_bytes()
for name, args in (("zero", ("add", "0m", "x")), ("more than a day", ("add", "25h", "x")), ("not a duration", ("add", "soon", "x")), ("a negative one", ("add", "-5m", "x")), ("a date that does not exist", ("add", "1h", "x", "--date", "2026-02-30")), ("rm of an id not there", ("rm", "99")), ("half minutes", ("add", "0.01h", "x"))):
    want(f"an error: {name}", t(*args), 2)
c.row("an error leaves tally.json as it was", (box / "tally.json").read_bytes() == before)
want("rm", t("rm", "3"), 0, "removed 3")
want("an id is not used again", t("add", "24h", "long day", "--date", "2026-02-28"), 0, "added 6")
want("100 hours are 100:00", (lambda: [t("add", "24h", "x", "--date", "2026-02-27") for _ in range(3)] and t("sum", "--to", "2026-02-28"))(), 0, "total 96:00")
want("export", t("export", "out.csv"), 0, "exported 8")
rows = list(csv.reader(io.StringIO((box / "out.csv").read_text("utf-8")))) if (box / "out.csv").exists() else []
c.row("the CSV: header, order of list, tags by a space", rows[:1] == [["id", "date", "minutes", "text", "tags"]] and [r[0] for r in rows[1:]] == ["7", "8", "9", "6", "2", "1", "4", "5"] and ["1", "2026-03-02", "90", "write report", "admin docs"] in rows, rows[:4])
c.row("no half-written file left", not [p.name for p in box.iterdir() if p.name not in ("tally.json", "out.csv")], [p.name for p in box.iterdir()])
code, out, err = c.python("-m", "unittest", "test_tally", "-q")
import re
ran = re.search(r"Ran (\d+) test", err + out)
c.row("its own tests pass, and there are at least six", code == 0 and ran and int(ran.group(1)) >= 6 if c.reply is not None else code == 0, (err or out)[-200:])
shutil.rmtree(box, ignore_errors=True)

c.done()
