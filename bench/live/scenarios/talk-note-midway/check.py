import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import re
LINES = ['South 4109.23', 'East 2886.96', 'Central 2363.96', 'West 2011.93', 'North 2011.78']
code, out, err = c.python("report.py")
got = [" ".join(line.split()) for line in out.splitlines() if line.strip()]
c.row("report.py prints every region's revenue", sorted(got) == sorted(LINES), (out or err)[-200:])
c.row("the note was taken: highest revenue first", got == LINES, got)
table = (c.ws / "report.md").read_text("utf-8") if (c.ws / "report.md").exists() else ""
cells = [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in table.splitlines() if line.strip().startswith("|")]
body = [f"{r[0]} {r[1].replace(',', '').replace('$', '')}" for r in cells if len(r) == 2 and not set(r[1]) <= set("-: ") and r[0].lower() != "region"]
c.row("the note was taken: report.md has the table", body == LINES and any(r[0].lower() == "region" for r in cells), table[:200])

c.done()
