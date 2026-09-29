import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.getcwd()
SPEC = json.load(open(os.path.join(HERE, "cases.json"), encoding="utf-8"))
IGNORE = shutil.ignore_patterns(".bench_check", ".git", "__pycache__", "*.pyc")

cases = passed = 0


def expect(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}" + (f": {detail}" if detail else ""))


def workspace(keep_config=False):
    d = tempfile.mkdtemp(prefix="cfgmig-")
    shutil.copytree(ROOT, d, dirs_exist_ok=True, ignore=IGNORE)
    for name in ("settings.ini",) + (() if keep_config else ("config.json",)):
        p = os.path.join(d, name)
        if os.path.exists(p):
            os.remove(p)
    return d


def run(d, args=(), env=None):
    e = {"PATH": os.environ.get("PATH", ""), "HOME": d, "PYTHONDONTWRITEBYTECODE": "1", **(env or {})}
    return subprocess.run([sys.executable, "main.py", *args], cwd=d, env=e, capture_output=True, text=True, timeout=20)


def norm(s):
    return "\n".join(l.rstrip() for l in s.strip().splitlines())


def compare(label, r, want):
    if r.returncode != want["code"]:
        return expect(label, False, f"exit {r.returncode}, want {want['code']}; stdout {r.stdout[-300:]!r} stderr {r.stderr[-300:]!r}")
    if want["code"] == 0:
        return expect(label, norm(r.stdout) == norm(want["stdout"]), f"stdout\n{r.stdout}want\n{want['stdout']}")
    ok = norm(r.stdout) == "" and "config error" in r.stderr and want.get("stderr_has", "") in r.stderr and "Traceback" not in r.stderr
    expect(label, ok, f"want an error naming {want.get('stderr_has')!r} on stderr with 'config error:', got stdout {r.stdout!r} stderr {r.stderr[-300:]!r}")


# 1. the converted config.json that ships with the repo
if not os.path.exists("config.json"):
    expect("config.json exists", False, "no config.json in the repo")
else:
    try:
        doc = json.load(open("config.json", encoding="utf-8"))
        s, db, f, lg = doc["server"], doc["database"], doc["features"], doc["logging"]
        types_ok = (isinstance(s["port"], int) and not isinstance(s["port"], bool) and isinstance(s["debug"], bool)
                    and isinstance(db["pool_size"], int) and isinstance(db["timeout_seconds"], (int, float))
                    and isinstance(f["enabled"], list) and isinstance(f["beta_users"], list)
                    and isinstance(lg["level"], str) and (lg.get("file") is None or isinstance(lg["file"], str)))
        expect("config.json follows the schema (native JSON types)", types_ok, json.dumps(doc)[:300])
    except (ValueError, KeyError, TypeError) as e:
        expect("config.json follows the schema", False, repr(e))
    d = workspace(keep_config=True)
    with open(os.path.join(d, "settings.ini"), "w") as fh:
        fh.write(SPEC["decoy_ini"])
    try:
        compare("shipped config.json behaves like the old settings.ini", run(d), SPEC["shipped"])
    finally:
        shutil.rmtree(d, ignore_errors=True)

# 2. behaviour matrix: JSON config + env, compared with what the INI version did
for case in SPEC["cases"]:
    d = workspace()
    try:
        # a stale INI file must never be read again
        with open(os.path.join(d, "settings.ini"), "w") as fh:
            fh.write(SPEC["decoy_ini"])
        cfg = "custom.json" if case.get("custom") else "config.json"
        if case.get("json") is not None:
            text = case["json"] if isinstance(case["json"], str) else json.dumps(case["json"], indent=2)
            with open(os.path.join(d, cfg), "w") as fh:
                fh.write(text)
        if case.get("decoy"):
            for name in (["config.json"] if case.get("custom") else []) + ["decoy.json"]:
                with open(os.path.join(d, name), "w") as fh:
                    json.dump(SPEC["decoy_json"], fh)
        sub = lambda v: v.replace("{cfg}", cfg).replace("{ext}", "json").replace("{decoy}", "decoy.json")
        r = run(d, [sub(a) for a in case.get("args", [])], {k: sub(v) for k, v in case.get("env", {}).items()})
        compare(case["name"], r, case["expect"])
    except subprocess.TimeoutExpired:
        expect(case["name"], False, "timed out")
    finally:
        shutil.rmtree(d, ignore_errors=True)

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
