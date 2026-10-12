import hashlib, json, sys

WORDS = "checkout cart search invoice ledger export sync mobile banner promo login signup profile theme upload report audit refund tax shipping".split()
TEAMS = ["team-atlas", "team-orion", "team-lyra", "team-vega", "team-draco"]
NOTES = ["", "", "ramp slowly", "ask before removing", "caf\u00e9 pilot \u2615", "\u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u0432 \u043c\u0430\u0435", "see ticket #%d"]


def original():
    """The file as the task starts with it: the same code wrote files/site/flags.min.json."""
    def n(i, salt):
        return int(hashlib.sha256(f"flags:{salt}:{i}".encode()).hexdigest()[:8], 16)
    flags = {}
    for i in range(1500):
        name = f"{WORDS[n(i, 'a') % len(WORDS)]}_{WORDS[n(i, 'b') % len(WORDS)]}_{i:04d}"
        if i == 811:
            name = "beta_checkout_v2"
        note = NOTES[n(i, 'n') % len(NOTES)]
        flags[name] = {"enabled": n(i, 'e') % 3 != 0, "owner": TEAMS[n(i, 'o') % len(TEAMS)], "rollout": n(i, 'r') % 101, "note": note % i if "%d" in note else note}
    flags["beta_checkout_v2"]["owner"] = "team-atlas"
    return {
        "version": 41,
        "services": {
            "search": {"retry": {"max_attempts": 3, "backoff_ms": 100}, "timeout_ms": 800},
            "billing": {"retry": {"max_attempts": 3, "backoff_ms": 250}, "timeout_ms": 4000},
            "export": {"retry": {"max_attempts": 5, "backoff_ms": 500}, "timeout_ms": 30000},
        },
        "flags": flags,
    }


def pack(data):
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


def wanted():
    data = original()
    data["version"] = 42
    data["services"]["billing"]["retry"]["max_attempts"] = 7
    data["flags"] = {("checkout_v2" if name == "beta_checkout_v2" else name): flag for name, flag in data["flags"].items() if flag["owner"] != "team-orion"}
    return data


if __name__ == "__main__":
    want = wanted()
    checks = []
    try:
        raw = open("site/flags.min.json", "rb").read()
        got = json.loads(raw.decode("utf-8"))
    except Exception as e:
        print(f"site/flags.min.json does not load: {e}")
        print("SCORE 0/6")
        sys.exit(1)
    flags = got.get("flags", {})
    checks.append(("version is 42", got.get("version") == 42))
    checks.append(("billing retries are 7 and nothing else in services moved", got.get("services") == want["services"]))
    checks.append(("the flag is renamed in place", "beta_checkout_v2" not in flags and list(flags).index("checkout_v2") == list(want["flags"]).index("checkout_v2") if "checkout_v2" in flags else False))
    checks.append(("no team-orion flag is left", flags and all(f.get("owner") != "team-orion" for f in flags.values())))
    checks.append(("every other flag is as it was, in the same order", list(flags.items()) == list(want["flags"].items())))
    checks.append(("still one minified line, same bytes as a careful edit", raw == pack(want).encode("utf-8")))
    for label, ok in checks:
        if not ok:
            print(f"FAIL {label}")
    good = sum(1 for _, ok in checks if ok)
    print(f"SCORE {good}/{len(checks)}")
    sys.exit(0 if good == len(checks) else 1)
