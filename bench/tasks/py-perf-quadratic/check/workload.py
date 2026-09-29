"""Run one large workload against a ranges module and report time + result digest.

usage: workload.py <module-dir> <merge|count|gaps>
"""
import hashlib
import importlib.util
import os
import random
import sys
import time


def load(dirpath, name="ranges"):
    path = os.path.join(dirpath, name + ".py")
    spec = importlib.util.spec_from_file_location("ranges_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, dirpath)
    spec.loader.exec_module(mod)
    return mod


def make(kind):
    rnd = random.Random(20240917)
    if kind == "merge":
        rs = []
        for _ in range(200_000):
            a = rnd.randrange(0, 2_000_000_000)
            b = a + rnd.randrange(0, 3000)
            rs.append((b, a) if rnd.random() < 0.1 else (a, b))
        return (rs,)
    if kind == "count":
        rs = []
        for _ in range(100_000):
            a = rnd.randrange(-50_000_000, 50_000_000)
            b = a + rnd.randrange(0, 2_000_000)
            rs.append([b, a] if rnd.random() < 0.1 else [a, b])
        pts = [rnd.randrange(-60_000_000, 60_000_000) for _ in range(100_000)]
        pts += [r[0] for r in rs[:500]] + [r[1] for r in rs[:500]]
        return rs, pts
    if kind == "gaps":
        rs = []
        for _ in range(100_000):
            a = rnd.randrange(0, 1_000_000_000)
            rs.append((a, a + rnd.randrange(0, 5000)))
        return rs, 1_000, 999_000_000
    raise SystemExit(f"unknown workload {kind}")


def digest(result):
    h = hashlib.sha256()
    for item in result:
        h.update(repr(tuple(item) if isinstance(item, (list, tuple)) else item).encode())
        h.update(b";")
    return f"{len(result)}:{h.hexdigest()}"


if __name__ == "__main__":
    dirpath, kind = sys.argv[1], sys.argv[2]
    mod = load(dirpath, sys.argv[3] if len(sys.argv) > 3 else "ranges")
    args = make(kind)
    fn = {"merge": mod.merge_ranges, "count": mod.count_covering, "gaps": mod.gaps}[kind]
    t0 = time.perf_counter()
    result = list(fn(*args))
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.4f} {digest(result)}")
