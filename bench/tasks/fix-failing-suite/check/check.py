"""Run the ORIGINAL test suite (pristine copy, so edited tests don't count) and hidden tests."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

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
        total += 1
        all_green = False
        continue
    print(f"{label}: {data['run']} tests, {len(data['failed'])} failing")
    for name in data["failed"]:
        print(f"FAIL {label}: {name}")
    for line in data["detail"]:
        print(f"   {line}")
    total += data["run"]
    got += data["run"] - len(data["failed"])
    all_green = all_green and data["run"] > 0 and not data["failed"]

print(f"SCORE {got}/{total}")
sys.exit(0 if all_green else 1)
