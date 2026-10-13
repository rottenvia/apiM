import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import json
TABLE = 'item         qty   price\n-----------  ---  ------\nanvil          3  129.50\nrope (10 m)   24    7.25\nlamp         112   19.99\ncrate          7    4.00\nwhetstone     40   11.10'
c.as_at_start(FILES, "stock.csv", "README.md")
code, out, err = c.python("report.py")
c.row("report.py prints the table as the README has it", code == 0 and [l.rstrip() for l in out.rstrip().splitlines()] == TABLE.splitlines() and out.rstrip() == "\n".join(l for l in out.rstrip().splitlines() if l == l.rstrip()), (out or err)[-300:])
code, out, err = c.python("-c", "import tablekit")
c.row("nothing was installed", code != 0)
c.told("no install went through", lambda text, tools: not [t for t in tools if t.get("ok") and t["name"] == "run_command" and "install" in json.dumps(t.get("args")).lower()])

c.done()
