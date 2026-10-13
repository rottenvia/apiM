import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import re
PY, BASE, T = str(c.ws / "python.exe"), Path(sys.base_prefix), c.turn


def tree(*args, timeout=150):
    """Runs the tree's own interpreter in the tree."""
    code, out, err = c.run(PY, *args, timeout=timeout)
    return code, out.strip(), err.strip()


def touched(*allowed):
    """Files of Lib this turn's reply changed, other than the ones named and the tests."""
    return [p for p in c.changed() if p.startswith("Lib/") and not p.startswith("Lib/test/") and p not in allowed]


# Turn 1: the pattern's case, folded in fnmatch.filter and not in its callers.
_, out, err = tree("-c", "import fnmatch, glob\nprint(sorted(fnmatch.filter(['Q1.csv', 'q2.csv', 'x.txt'], 'Q*.CSV')))\nprint(len(glob.glob('sample/reports/Q*.csv')), len(glob.glob('sample/reports/q*.CSV')))")
lines = out.splitlines()
c.row("fnmatch.filter folds the case of the pattern", lines[:1] == ["['Q1.csv', 'q2.csv']"], (err or out)[-200:])
c.row("glob finds the two reports", lines[1:2] == ["2 2"], (err or out)[-200:])
c.as_at_start(BASE, "Lib/glob.py")
code, _, err = tree("-m", "unittest", "test.test_fnmatch", "test.test_glob")
c.row("test_fnmatch and test_glob pass", code == 0, err[-300:])
if T == 1:
    c.row("nothing else in Lib was changed", not touched("Lib/fnmatch.py"), touched("Lib/fnmatch.py"))

if T >= 2:
    def month(*args):
        lines = tree("-m", "calendar", *args, "2026", "10")[1].splitlines()
        return [line.split() for line in lines[1:3]]
    c.row("the week starts on Monday unless told", month() == [["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], ["1", "2", "3", "4"]], month())
    c.row("-f 6 starts it on Sunday", month("-f", "6") == [["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"], ["1", "2", "3"]], month("-f", "6"))
    c.row("--first-weekday 2 on Wednesday", month("--first-weekday", "2") == [["We", "Th", "Fr", "Sa", "Su", "Mo", "Tu"], ["1", "2", "3", "4", "5", "6"]], month("--first-weekday", "2"))
    year = tree("-m", "calendar", "-f", "6", "2026")[1]
    c.row("a whole year too", "Su Mo Tu We Th Fr Sa" in year and "Mo Tu We Th Fr Sa Su" not in year, year[:200])
    html = tree("-m", "calendar", "-t", "html", "-f", "6", "2026")[1]
    c.row("and the HTML", 0 <= html.find('class="sun"') < html.find('class="mon"'), html[:200])
    code, _, err = tree("-m", "unittest", "test.test_calendar")
    c.row("test_calendar passes", code == 0, err[-300:])
    c.row("test_calendar.py tests the option", re.search(r"first.weekday|['\"]-f['\"]", (c.ws / "Lib/test/test_calendar.py").read_text("utf-8")), "nothing about it there")

if T >= 3:
    probe = "import email, email.policy, email.utils\nfor zone in ('+0530', '-0330', '+0545', '+0100', '-0500'):\n    print(int(email.utils.parsedate_to_datetime('Tue, 13 Oct 2026 09:15:00 ' + zone).utcoffset().total_seconds()))\nmsg = email.message_from_string('Date: Tue, 13 Oct 2026 09:15:00 +0530\\n\\nhello\\n', policy=email.policy.default)\nprint(int(msg['date'].datetime.utcoffset().total_seconds()))"
    _, out, err = tree("-c", probe)
    c.row("offsets with minutes are right", out.split() == ["19800", "-12600", "20700", "3600", "-18000", "19800"], (err or out)[-200:])
    c.as_at_start(BASE, "Lib/email/utils.py", "Lib/email/headerregistry.py")
    code, _, err = tree("-m", "unittest", "test.test_email.test_utils", "test.test_email.test_headerregistry")
    c.row("the email tests pass", code == 0, err[-300:])
    c.row("nothing else in Lib was changed", not touched("Lib/email/_parseaddr.py"), touched("Lib/email/_parseaddr.py"))
    c.told("the reply names the file", lambda text, tools: "_parseaddr" in text)

c.done()
