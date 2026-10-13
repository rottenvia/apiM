import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import ast, json, re, shutil, tempfile
from datetime import date, timedelta
import checklib

T = c.turn
tmp = Path(tempfile.mkdtemp())
BOOKS = (("b1", "Dune", "12.50"), ("b2", "Emma", "8"), ("b3", "Ulysses", "20"), ("b4", "Persuasion", "6"))


def cli(store, today, *args):
    code, out, err = c.python("-m", "loans", "--store", str(tmp / store), "--today", today, *args, timeout=30)
    return code, out.strip().splitlines(), err.strip()


def seed(store):
    """A store with four books and two members, made once the way a user makes one, then copied."""
    if not (tmp / "seed").exists():
        for book in BOOKS:
            cli("seed", "2026-03-01", "add-book", *book)
        for member in ("m1", "m2"):
            cli("seed", "2026-03-01", "add-member", member, member.upper())
    if (tmp / "seed").exists():
        shutil.copyfile(tmp / "seed", tmp / store)
    return store


def listing(store, today, command):
    """Exit code, the branch line a listing opens with from turn 11 on, and the words of every line under it."""
    code, lines, _ = cli(store, today, command)
    head = lines[:1] if T >= 11 else []
    return code, head, [line.split() for line in lines[len(head):]]


def day(n):
    return (date(2026, 3, 15) + timedelta(days=n)).isoformat()


def fine_on_return(days_late):
    s = seed("fine.json")
    cli(s, "2026-03-01", "lend", "b2", "m1")
    return [line for line in cli(s, day(days_late), "return", "b2")[1] if "fine" in line.lower()]


# Turn 1: the report.
s = seed("report.json")
code, _, rows = listing(s, "2026-03-01", "report")
c.row("report with nothing out says `no loans`", code == 0 and rows == [["no", "loans"]], f"exit {code}: {rows}")
cli(s, "2026-03-01", "lend", "b1", "m1")
rows = listing(s, "2026-03-02", "report")[2]
c.row("report lists a loan", rows == [["Dune", "m1", "due", "2026-03-15"]], rows)

if T >= 2:
    small, big = ("0.75" if T < 9 else "0.25"), ("8.00" if T < 6 else "15.00" if T < 9 else "14.50")
    for name, days, want in (("3 days late", 3, [f"fine: {small}"]), ("60 days late", 60, [f"fine: {big}"]), ("2 days late", 2, ["fine: 0.50"] if T < 9 else []), ("on time costs nothing", 0, []), ("back early costs nothing", -4, [])):
        got = fine_on_return(days)
        c.row(name, got == want, got)
    probe = "import json, sys\nfrom datetime import date\nfrom loans.core import fine_cents\nstate = json.load(open(sys.argv[1], encoding='utf-8'))\nloan = state['loans'][0]\ntry:\n    v = fine_cents(loan, state, date(2026, 3, 18))\nexcept TypeError:\n    v = fine_cents(loan, date(2026, 3, 18))\nprint(type(v).__name__, v)"
    s = seed("probe.json")
    cli(s, "2026-03-01", "lend", "b2", "m1")
    _, out, err = c.python("-c", probe, str(tmp / s))
    c.row("fine_cents gives whole cents, from loans.core", out.strip() == f"int {75 if T < 9 else 25}", (err or out)[-200:])

if T >= 3:
    s = seed("renew.json")
    cli(s, "2026-03-01", "lend", "b1", "m1")
    first = cli(s, "2026-03-02", "renew", "b1")[0]
    due = listing(s, "2026-03-02", "report")[2]
    c.row("renew pushes the due date 14 days on", first == 0 and due == [["Dune", "m1", "due", "2026-03-29"]], f"exit {first}: {due}")
    second = cli(s, "2026-03-03", "renew", "b1")[0]
    code, _, err = cli(s, "2026-03-04", "renew", "b1")
    due = listing(s, "2026-03-04", "report")[2]
    c.row("a second time too", second == 0 and due == [["Dune", "m1", "due", "2026-04-12"]], f"exit {second}: {due}")
    c.row("a third time is an error", code == 2 and err.startswith("loans: ") and "Traceback" not in err, f"exit {code}: {err[-200:]}")
    readme = (c.ws / "README.md").read_text("utf-8") if (c.ws / "README.md").exists() else ""
    c.row("README's table has renew", re.search(r"(?m)^\|.*\brenew\b", readme), "no row for it")
if 3 <= T <= 10:
    named = [p.relative_to(c.ws).as_posix() for p in c.ws.rglob("*") if p.is_file() and not checklib.LEFTOVERS & set(p.relative_to(c.ws).parts) and b"KX-417" in p.read_bytes()]
    c.row("the branch code is in no file yet", not named, named)

if T >= 4:
    s = seed("back.json")
    code, _, err = cli(s, "2026-03-02", "return", "b1")
    c.row("return of a book that is not out", code == 2 and err == "loans: book b1 is not out", f"exit {code}: {err[-200:]}")
    code, _, err = cli(s, "2026-03-02", "return", "nope")
    c.row("return of a book nobody knows", code == 2 and err.startswith("loans: ") and "Traceback" not in err, f"exit {code}: {err[-200:]}")

if T >= 5:
    s = seed("limit.json")
    three = [cli(s, "2026-03-01", "lend", book, "m1")[0] for book in ("b1", "b2", "b3")]
    code, _, err = cli(s, "2026-03-01", "lend", "b4", "m1")
    cli(s, "2026-03-02", "return", "b1")
    c.row("three books are lent", three == [0, 0, 0], three)
    c.row("a fourth is refused", code == 2 and err.startswith("loans: "), f"exit {code}: {err[-200:]}")
    c.row("there is room again after a return", cli(s, "2026-03-02", "lend", "b4", "m1")[0] == 0)

if T >= 7:
    s = seed("late.json")
    for book, member, lent in (("b1", "m1", "2026-03-01"), ("b2", "m2", "2026-03-05"), ("b3", "m2", "2026-03-05"), ("b4", "m1", "2026-03-20")):
        cli(s, lent, "lend", book, member)
    fines = ("2.50", "1.50") if T < 9 else ("2.00", "1.00")
    code, _, rows = listing(s, "2026-03-25", "overdue")
    c.row("overdue: the most days late first, ties by book", code == 0 and rows == [["10", "b1", "m1", fines[0]], ["6", "b2", "m2", fines[1]], ["6", "b3", "m2", fines[1]]], f"exit {code}: {rows}")
    rows = listing(s, "2026-03-10", "overdue")[2]
    c.row("overdue with nothing late", rows == [["nothing", "overdue"]], rows)
    if T >= 9:
        rows = listing(s, "2026-03-16", "overdue")[2]
        c.row("a day late shows, with 0.00", rows == [["1", "b1", "m1", "0.00"]], rows)
    cli(s, "2026-03-25", "return", "b1")
    rows = listing(s, "2026-03-25", "overdue")[2]
    c.row("a book that is back is not overdue", [row[1:2] for row in rows] == [["b2"], ["b3"]], rows)
    c.row("README's table has overdue", re.search(r"(?m)^\|.*\boverdue\b", readme), "no row for it")

if T >= 8:
    def where():
        fines = c.ws / "loans" / "fines.py"
        if not fines.exists():
            return "there is no loans/fines.py"
        if not any(isinstance(n, ast.FunctionDef) and n.name == "fine_cents" for n in ast.parse(fines.read_text("utf-8")).body):
            return "loans/fines.py does not define fine_cents"
        if any(isinstance(n, ast.Constant) and n.value == 25 and not isinstance(n.value, bool) for n in ast.walk(ast.parse((c.ws / "loans" / "core.py").read_text("utf-8")))):
            return "loans/core.py still holds the 25"
    c.test("fines live in loans/fines.py", where)

if T >= 10:
    s = seed("price.json")
    for n, price in enumerate(("19.99", "0.29", "1.15", "2.01", "5", "12.50")):
        cli(s, "2026-03-01", "add-book", f"p{n}", "Priced", price)
    stored = (tmp / s).read_text("utf-8") if (tmp / s).exists() else ""
    missing = [want for want in (1999, 29, 115, 201, 500, 1250) if not re.search(rf"(?<![\d.]){want}(?![\d.])", stored)]
    c.row("prices are read to the cent", not missing, f"not in the store: {missing}")
    floats = [p.name for p in (c.ws / "loans").rglob("*.py") if re.search(r"\bfloat\s*\(", p.read_text("utf-8"))]
    c.row("no float touches money in loans/", not floats, floats)
if T == 10:
    c.told("the reply names the five rules", lambda text, tools: all(re.search(word, text, re.I) for word in ("cent", "changelog", "test", "legacy", "readme")))

if T >= 11:
    s = seed("branch.json")
    heads = [listing(s, "2026-03-25", "report")[1], listing(s, "2026-03-25", "overdue")[1]]
    cli(s, "2026-03-01", "lend", "b1", "m1")
    heads += [listing(s, "2026-03-25", "report")[1], listing(s, "2026-03-25", "overdue")[1]]
    c.row("report and overdue open with the branch code", heads == [["Branch KX-417"]] * 4, heads)
if T == 11:
    c.told("the code was not asked for again", lambda text, tools: not any(t["name"] == "ask_user" for t in tools))

if T >= 12:
    tail = readme.split("## Not supported", 1)[1] if "## Not supported" in readme else ""
    c.row("README says what is not supported, and why", re.search(r"e-?books?", tail, re.I) and re.search(r"licen[cs]e", tail, re.I), tail[:200] or "no such section")

# The rules of the first message, at every turn.
c.passes("the tests pass", "-m", "unittest", "-q")
def tests():
    return sum(isinstance(n, ast.FunctionDef) and n.name.startswith("test") for p in (c.ws / "tests").rglob("*.py") for n in ast.walk(ast.parse(p.read_text("utf-8"))))
need = [0, 5, 6, 7, 8, 9, 9, 10, 10, 11, 11, 12, 12][T]
c.test(f"rule 3: at least {need} tests by now", lambda: True if tests() >= need else f"{tests()} tests")
log = (c.ws / "CHANGELOG.md").read_text("utf-8") if (c.ws / "CHANGELOG.md").exists() else ""
found = re.search(r"(?ms)^## Unreleased[^\n]*\n(.*?)(?=^## |\Z)", log)
lines = len(re.findall(r"(?m)^\s*[-*] \S", found[1])) if found else 0
need = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 10][T]
c.row(f"rule 2: at least {need} lines under Unreleased", lines >= need, f"{lines} lines")
c.as_at_start(FILES, "legacy/import_v1.py")
shutil.rmtree(tmp, ignore_errors=True)

c.done()
