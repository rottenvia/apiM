import json, sys
sys.path.insert(0, ".")
import pipeline

lines = []
pipeline.run(lambda text: lines.append(f"{len(lines) + 1:05d} {text}"), pause=lambda s: None)


def field(line, name):
    return next(p.split("=", 1)[1] for p in line.split() if p.startswith(name + "="))


batches = [l for l in lines if " batch=" in l]
slow = max(batches, key=lambda l: int(field(l, "ms")))
error = next(l for l in lines if l.split()[1] == "ERROR")
want = {
    "checksum_ledger_0417": field(next(l for l in batches if " ledger batch=0417 " in l), "checksum"),
    "warn_lines_normalize": sum(1 for l in batches if l.split()[1] == "WARN" and l.split()[2] == "normalize"),
    "error": {"line": int(error.split()[0]), "code": field(error, "code")},
    "slowest": {"stage": slow.split()[2], "batch": int(field(slow, "batch"))},
    "total_ms": int(field(lines[-1], "total_ms")),
}
try:
    got = json.load(open("answers.json", encoding="utf-8"))
except Exception as e:
    print(f"answers.json: {e}")
    print(f"SCORE 0/{len(want)}")
    sys.exit(1)
ok = 0
for key, value in want.items():
    mine = got.get(key)
    if isinstance(value, dict) and isinstance(mine, dict):
        mine = {k: (int(v) if isinstance(value[k], int) and str(v).lstrip("0").isdigit() else v) for k, v in mine.items() if k in value}
    if mine == value or (isinstance(value, int) and str(mine).isdigit() and int(mine) == value):
        ok += 1
    else:
        print(f"FAIL {key}: got {got.get(key)!r}")
print(f"SCORE {ok}/{len(want)}")
sys.exit(0 if ok == len(want) else 1)
