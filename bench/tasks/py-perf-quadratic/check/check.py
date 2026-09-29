"""Hidden grader for py-perf-quadratic: same results as before, and fast on large inputs."""
import importlib.util
import os
import random
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.getcwd()

cases = 0
passed = 0


def check(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}: {detail}")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


orig = load(os.path.join(HERE, "orig_ranges.py"), "orig_ranges")
try:
    sys.path.insert(0, WS)
    new = load(os.path.join(WS, "ranges.py"), "ranges")
except Exception as e:  # noqa: BLE001
    print(f"FAIL cannot import ranges.py: {e!r}")
    print("SCORE 0/1")
    sys.exit(1)


def norm(result):
    if not isinstance(result, list):
        return ("not a list", type(result).__name__)
    return [tuple(x) if isinstance(x, (list, tuple)) else x for x in result]


def call(fn, *args):
    try:
        return norm(fn(*args))
    except Exception as e:  # noqa: BLE001
        return f"raised {type(e).__name__}"


rnd = random.Random(99)


def rand_ranges(n, span=25):
    out = []
    for _ in range(n):
        a, b = rnd.randint(-span, span), rnd.randint(-span, span)
        if rnd.random() < 0.3:
            b = a + rnd.randint(0, 3)
        out.append([a, b] if rnd.random() < 0.3 else (a, b))
    return out


# ---- small cases, compared with the original implementation
fixed = [[], [(1, 3), (4, 6)], [(1, 3), (5, 6)], [(5, 1)], [(2, 2), (2, 2)], [(0, 10), (2, 3), (11, 11)],
         [(-5, -1), (0, 0), (2, 4)], [(10, 20), (1, 5), (6, 9)], [(3, 1), (1, 3)], [(1, 1), (3, 3), (2, 2)]]
suites = {"merge_ranges": [], "count_covering": [], "gaps": []}
for rs in fixed + [rand_ranges(rnd.randint(0, 12)) for _ in range(400)]:
    suites["merge_ranges"].append((rs,))
    pts = [rnd.randint(-30, 30) for _ in range(rnd.randint(0, 8))]
    pts += [x for r in rs[:3] for x in r]
    suites["count_covering"].append((rs, pts))
    lo = rnd.randint(-30, 30)
    suites["gaps"].append((rs, lo, lo + rnd.randint(-3, 40)))
suites["gaps"] += [([], 5, 5), ([], 5, 4), ([(1, 10)], 1, 10), ([(1, 10)], 0, 11), ([(3, 4)], 4, 4), ([(3, 4)], 5, 5)]
for name, arg_list in suites.items():
    bad = None
    for args in arg_list:
        want = call(getattr(orig, name), *[list(a) if isinstance(a, list) else a for a in args])
        got = call(getattr(new, name), *[list(a) if isinstance(a, list) else a for a in args])
        if got != want:
            bad = (args, got, want)
            break
    check(f"{name} matches the original on small inputs", bad is None,
          bad and f"{name}{bad[0]!r} -> {bad[1]!r}, want {bad[2]!r}")

rs = [(5, 1), (7, 9), (3, 4)]
check("accepts one-shot iterators", call(new.merge_ranges, iter(rs)) == call(orig.merge_ranges, iter(rs))
      and call(new.count_covering, iter(rs), iter([1, 4, 8])) == call(orig.count_covering, iter(rs), iter([1, 4, 8]))
      and call(new.gaps, iter(rs), 0, 12) == call(orig.gaps, iter(rs), 0, 12), "a generator argument gave a different result")
data = [[9, 2], [1, 1], (4, 6)]
pts = [7, 1, 3]
snapshot = repr((data, pts))
new.merge_ranges(data)
new.count_covering(data, pts)
new.gaps(data, 0, 10)
check("does not modify the caller's lists", repr((data, pts)) == snapshot, f"{snapshot} became {(data, pts)!r}")

# ---- large inputs, time-limited; the limit is calibrated on this machine
for kind in ("merge", "count", "gaps"):
    ref = subprocess.run([sys.executable, os.path.join(HERE, "workload.py"), HERE, kind, "fast_ref"],
                         capture_output=True, text=True, timeout=60)
    ref_time, ref_digest = ref.stdout.split()
    limit = max(5 * float(ref_time), 0.5)
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, "workload.py"), WS, kind],
                           capture_output=True, text=True, timeout=limit + 4)
    except subprocess.TimeoutExpired:
        check(f"large {kind} input", False, f"did not finish within {limit:.2f}s")
        continue
    if r.returncode != 0:
        check(f"large {kind} input", False, r.stderr.strip().splitlines()[-1:] or f"exit {r.returncode}")
        continue
    t, d = r.stdout.split()
    if d != ref_digest:
        check(f"large {kind} input", False, "wrong result on the large input")
    else:
        check(f"large {kind} input", float(t) <= limit, f"took {float(t):.2f}s, limit {limit:.2f}s")

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
