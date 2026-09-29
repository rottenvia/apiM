import json
import re
import sys

cases = passed = 0


def expect(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}" + (f": {detail}" if detail else ""))


try:
    with open("answers.json", encoding="utf-8") as fh:
        a = json.load(fh)
    if not isinstance(a, dict):
        raise ValueError("top level is not an object")
except (OSError, ValueError) as e:
    print(f"FAIL answers.json missing or invalid: {e}")
    print("SCORE 0/6")
    sys.exit(1)


def path_norm(p):
    p = str(p or "").strip().replace("\\", "/")
    i = p.find("fleetdesk/")
    return p[i:] if i >= 0 else p.lstrip("./")


def dotted(entry):
    """'fleetdesk/x/y.py:A.b' or 'fleetdesk.x.y:A.b' or 'fleetdesk.x.y.A.b' -> 'fleetdesk.x.y.A.b'"""
    s = str(entry).strip().replace("\\", "/")
    i = s.find("fleetdesk")
    s = s[i:] if i >= 0 else s
    s = re.sub(r"\(\)$", "", s)
    s = s.replace(".py:", ":").replace(".py.", ".").replace("/", ".").replace(":", ".").replace("::", ".")
    return re.sub(r"\.+", ".", s).strip(".")


def number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(ms)?\s*", str(v or ""))
    return float(m.group(1)) if m else None


def section(key):
    v = a.get(key)
    return v if isinstance(v, dict) else {}


# 1. audit writer
aw = section("audit_writer")
fn = str(aw.get("function", "")).strip().replace("()", "")
expect("audit_writer", path_norm(aw.get("file")) == "fleetdesk/storage/journal.py"
       and (fn.endswith("JournalWriter.flush") or fn == "flush"),
       f"got {aw!r}")

# 2. webhook backoff
wb = section("webhook_backoff")
key = str(wb.get("config_key", "")).strip().lower()
expect("webhook_backoff.config_key", key == "webhooks.delivery.backoff_initial_ms", f"got {key!r}")
expect("webhook_backoff.default", number(wb.get("default")) == 500, f"got {wb.get('default')!r}")

# 3. callers of SessionRepository.purge_expired
want = {
    "fleetdesk.services.session_service.SessionService.validate",
    "fleetdesk.services.retention_service.RetentionService.run",
    "fleetdesk.handlers.admin.run_maintenance",
    "fleetdesk.repositories.session_repo.SessionRepository.rotate",
}
got = a.get("purge_expired_callers")
got_set = {dotted(x) for x in got} if isinstance(got, list) else set()
expect("purge_expired_callers", got_set == want,
       f"missing {sorted(want - got_set)}, unexpected {sorted(got_set - want)}")

# 4. endpoint reachable without credentials
ue = section("unauthenticated_endpoint")
method = str(ue.get("method", "")).strip().upper()
path = str(ue.get("path", "")).strip().rstrip("/")
expect("unauthenticated_endpoint", method == "POST" and path == "/api/v1/webhooks/telematics/replay",
       f"got {method} {path}")

# 5. duplicate VIN status
expect("duplicate_vin_status", number(a.get("duplicate_vin_status")) == 422, f"got {a.get('duplicate_vin_status')!r}")

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
