"""Run the ORIGINAL test suite (pristine copy, so edited tests don't count) and hidden tests."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# number of test methods in each suite, so a module that fails to import
# still counts as all of its tests failing
EXPECTED = {"orig_tests": 19, "hidden_tests": 22}

total = got = 0
all_green = True
for label, d in (("original suite", "orig_tests"), ("hidden tests", "hidden_tests")):
    r = None
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, "runner.py"), os.path.join(HERE, d)],
                           capture_output=True, text=True, timeout=60)
        data = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:  # import error, hang, crash
        print(f"FAIL {label}: could not run ({type(e).__name__}); stderr: {(r.stderr if r else '')[-500:]}")
        total += EXPECTED[d]
        all_green = False
        continue
    print(f"{label}: {data['run']} tests, {len(data['failed'])} failing")
    for name in data["failed"]:
        print(f"FAIL {label}: {name}")
    for line in data["detail"]:
        print(f"   {line}")
    total += max(data["run"], EXPECTED[d])
    got += max(0, data["run"] - len(data["failed"]))
    all_green = all_green and data["run"] > 0 and not data["failed"]

print(f"SCORE {got}/{total}")
sys.exit(0 if all_green else 1)
