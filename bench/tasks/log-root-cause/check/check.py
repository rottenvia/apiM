import json
import sys

WANT_REQ = "req-0fe167"
TRAPS = {
    "req-b69faf": "that request hit the first pool timeout but succeeded on retry (201)",
    "req-aa825c": "that is the chronic report-export timeout (RPT-212), unrelated",
    "req-b84df6": "that is the SKU-0000 KeyError bug, 15 minutes before the incident",
    "req-ab971b": "that is the chronic report-export timeout (RPT-212), unrelated",
}
COMPONENTS = {"ledger-db", "ledger"}
WANT_KEY = "ledger.db.pool_max"

cases = passed = 0


def expect(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}" + (f": {detail}" if detail else ""))


try:
    with open("diagnosis.json", encoding="utf-8") as fh:
        d = json.load(fh)
    if not isinstance(d, dict):
        raise ValueError("not an object")
except (OSError, ValueError) as e:
    print(f"FAIL diagnosis.json missing or invalid: {e}")
    print("SCORE 0/3")
    sys.exit(1)


def norm(v):
    return str(v).strip().strip("[]").strip().lower() if v is not None else ""


req = norm(d.get("first_failure_request_id"))
if req.startswith("req=") :
    req = req[4:]
expect("first_failure_request_id", req == WANT_REQ, f"got {req!r}" + (f" ({TRAPS[req]})" if req in TRAPS else ""))
comp = norm(d.get("root_cause_component"))
expect("root_cause_component", comp in COMPONENTS, f"got {comp!r}")
key = norm(d.get("failing_config_key"))
expect("failing_config_key", key == WANT_KEY, f"got {key!r}")

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
