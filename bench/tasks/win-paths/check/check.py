import json, os, subprocess, sys

WANT = json.loads('{"Январь": {"реклама": 5306.48, "аренда": 6724.1, "связь": 7525.56, "канцтовары": 3596.98}, "Февраль": {"реклама": 6775.68, "зарплата": 6733.04, "канцтовары": 3723.74, "связь": 6875.02}, "Март": {"канцтовары": 6983.64, "зарплата": 14880.51, "связь": 2158.34, "аренда": 3041.65, "реклама": 300.99}, "всего": 74625.73}')
FILES = {'Январь': 'Январь (итог).csv', 'Февраль': 'Февраль (итог).csv', 'Март': 'Март — черновик.csv'}
checks = []
try:
    got = json.load(open("Итоги/2025 Q1.json", encoding="utf-8-sig"))
except Exception as e:
    print(f"Итоги/2025 Q1.json: {e}")
    got = {}


def same(a, b):
    return isinstance(a, dict) and set(a) == set(b) and all(isinstance(a[k], (int, float)) and abs(a[k] - b[k]) < 0.006 for k in b)


for month in FILES:
    checks.append((f"totals of {month}", same(got.get(month), WANT[month])))
checks.append(("grand total", isinstance(got.get("всего"), (int, float)) and abs(got["всего"] - WANT["всего"]) < 0.006))
# The script itself, as this PC runs it: no UTF-8 mode, paths with spaces, brackets and a dash.
env = {k: v for k, v in os.environ.items() if k != "PYTHONUTF8"}
env["PYTHONIOENCODING"] = "utf-8"
for month, name in FILES.items():
    run = subprocess.run([sys.executable, os.path.join("tools & scripts", "sum report.py"), os.path.join("Отчёты 2025", name)], capture_output=True, env=env, timeout=30)
    out = run.stdout.decode("utf-8", "replace")
    ok = run.returncode == 0 and all(c in out and f"{v:.2f}" in out for c, v in WANT[month].items())
    if not ok:
        print(run.stderr.decode("utf-8", "replace")[-300:])
    checks.append((f"the script totals {name}", ok))
for label, ok in checks:
    if not ok:
        print(f"FAIL {label}")
good = sum(1 for _, ok in checks if ok)
print(f"SCORE {good}/{len(checks)}")
sys.exit(0 if good == len(checks) else 1)
