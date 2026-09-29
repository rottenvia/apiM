"""Hidden grader for py-write-tests: the agent's suite must pass on the real module,
pass on a behaviour-identical rewrite, and fail on each of four subtly buggy versions."""
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.getcwd()
VARIANTS = os.path.join(HERE, "variants")
BUGGY = ["rounding", "negative_format", "negative_split", "leftover_by_weight"]
TIMEOUT = 12

if not os.path.isfile(os.path.join(WS, "tests", "test_money.py")):
    print("FAIL tests/test_money.py does not exist")
    print(f"SCORE 0/{len(BUGGY)}")
    sys.exit(1)

tmp_root = tempfile.mkdtemp(prefix="money-variants-")
procs = {}
try:
    for name in ["real", "equivalent", *BUGGY]:
        d = os.path.join(tmp_root, name)
        shutil.copytree(WS, d, ignore=shutil.ignore_patterns(".bench_check", "__pycache__", ".git"))
        shutil.copyfile(os.path.join(VARIANTS, f"{name}.py"), os.path.join(d, "money.py"))
        procs[name] = subprocess.Popen(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
            cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    results = {}
    for name, p in procs.items():
        try:
            out, _ = p.communicate(timeout=TIMEOUT)
            ran = re.search(r"Ran (\d+) tests?", out)
            results[name] = ("pass" if p.returncode == 0 and ran and int(ran.group(1)) > 0 else "fail", out)
        except subprocess.TimeoutExpired:
            p.kill()
            p.communicate()
            results[name] = ("timeout", "")
finally:
    shutil.rmtree(tmp_root, ignore_errors=True)


def tail(out, n=6):
    return " | ".join(out.strip().splitlines()[-n:])


ok = True
status, out = results["real"]
if status != "pass":
    ok = False
    print(f"FAIL the suite does not pass against the real money.py ({status}): {tail(out)}")
status, out = results["equivalent"]
if status != "pass":
    ok = False
    print(f"FAIL the suite fails on a correct re-implementation of the same behaviour ({status}); "
          f"it tests something other than the documented public behaviour: {tail(out)}")

caught = 0
for name in BUGGY:
    if results[name][0] == "pass":
        print(f"FAIL a buggy variant of money.py ({BUGGY.index(name) + 1}) passes the suite")
    else:
        caught += 1

print(f"SCORE {caught if ok else 0}/{len(BUGGY)}")
sys.exit(0 if ok and caught == len(BUGGY) else 1)
