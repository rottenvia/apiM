import json
import math
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXPECTED = json.load(open(os.path.join(HERE, "expected.json"), encoding="utf-8"))
TMP = tempfile.mkdtemp(prefix="hydro-check-")

cases = passed = 0


def expect(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}" + (f": {detail}" if detail else ""))


def same_num(got, want):
    if want is None:
        return got is None
    if isinstance(got, bool) or not isinstance(got, (int, float)):
        return False
    return math.isclose(got, want, rel_tol=1e-9, abs_tol=1e-9)


def row_problem(got, want):
    if not isinstance(got, dict):
        return f"not an object: {got!r}"
    if set(got) != set(want):
        return f"keys {sorted(got)} != {sorted(want)}"
    for k in ("region", "country"):
        if got[k] != want[k]:
            return f"{k} {got[k]!r} != {want[k]!r}"
    if not same_num(got["capacity_mw"], want["capacity_mw"]) or (
            isinstance(got["capacity_mw"], float) and not got["capacity_mw"].is_integer()):
        return f"capacity_mw {got['capacity_mw']!r} != {want['capacity_mw']!r}"
    gg, wg = got["generation_gwh"], want["generation_gwh"]
    if not isinstance(gg, dict) or set(gg) != set(wg):
        return f"generation_gwh keys {sorted(gg) if isinstance(gg, dict) else gg!r} != {sorted(wg)}"
    for y in wg:
        if not same_num(gg[y], wg[y]):
            return f"generation_gwh[{y}] {gg[y]!r} != {wg[y]!r}"
    if not same_num(got["share_pct"], want["share_pct"]):
        return f"share_pct {got['share_pct']!r} != {want['share_pct']!r}"
    return None


def compare(label, got, want):
    """One case per expected row, plus one for the row count."""
    if not isinstance(got, list):
        expect(f"{label}: output is a JSON array", False, type(got).__name__)
        for _ in want:
            expect(f"{label}: row", False)
        return
    expect(f"{label}: row count", len(got) == len(want), f"{len(got)} rows, want {len(want)}")
    by_country = {r.get("country"): r for r in got if isinstance(r, dict)}
    for i, w in enumerate(want):
        g = got[i] if i < len(got) and isinstance(got[i], dict) and got[i].get("country") == w["country"] else by_country.get(w["country"])
        if g is None:
            expect(f"{label}: row {w['country']!r}", False, "missing")
            continue
        p = row_problem(g, w)
        if p is None and got.index(g) != i:
            p = f"out of page order (at index {got.index(g)}, want {i})"
        expect(f"{label}: row {w['country']!r}", p is None, p or "")


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return "missing file"
    except ValueError as e:
        return f"invalid JSON: {e}"


# 1. the committed output for the page the agent was given
compare("hydro_2023.json", load("hydro_2023.json"), EXPECTED["hydro_2023"])

# 2. the script, re-run on the given page and on a later snapshot it has never seen
script_ok = os.path.exists("extract.py")
if script_ok:
    src = open("extract.py", encoding="utf-8", errors="replace").read()
    expect("extract.py uses only the standard library",
           not re.search(r"^\s*(import|from)\s+(bs4|lxml|html5lib|pandas)\b", src, re.M))
for name, page in (("rerun on hydro_2023.html", "hydro_2023.html"),
                   ("unseen 2024 snapshot", os.path.join(HERE, "hydro_2024.html"))):
    key = "hydro_2023" if "2023" in page else "hydro_2024"
    out = os.path.join(TMP, key + ".json")
    if not script_ok:
        compare(name, "extract.py missing", EXPECTED[key])
        continue
    try:
        r = subprocess.run([sys.executable, "extract.py", page, out], capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            print(f"extract.py exited {r.returncode} on {name}: {r.stderr[-400:]}")
        compare(name, load(out), EXPECTED[key])
    except subprocess.TimeoutExpired:
        compare(name, "timeout", EXPECTED[key])

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
