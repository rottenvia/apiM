import sys
import time
import traceback

sys.path.insert(0, ".")

cases = 0
passed = 0


def case(label):
    def deco(fn):
        global cases, passed
        cases += 1
        try:
            fn()
            passed += 1
        except Exception as e:  # noqa: BLE001 - any failure is a failed case
            detail = "".join(traceback.format_exception_only(type(e), e)).strip()
            print(f"FAIL {label}: {detail}")
        return fn
    return deco


def eq(got, want, what=""):
    if got != want:
        raise AssertionError(f"{what} got {got!r}, want {want!r}")


def raises(exc, fn, what=""):
    try:
        fn()
    except exc:
        return
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"{what} raised {type(e).__name__}, want {exc.__name__}")
    raise AssertionError(f"{what} did not raise {exc.__name__}")


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


try:
    from lru import LRUCache
except Exception as e:  # noqa: BLE001
    print(f"FAIL cannot import LRUCache from lru.py: {e}")
    print("SCORE 0/1")
    sys.exit(1)


def make(cap, **kw):
    clock = kw.pop("clock", None) or Clock()
    return LRUCache(cap, clock=clock, **kw), clock


@case("basic put/get and default")
def _():
    c, _ = make(2)
    c.put("a", 1)
    eq(c.get("a"), 1)
    eq(c.get("zz"), None)
    eq(c.get("zz", 7), 7)
    eq(c.capacity, 2, "capacity")


@case("evicts least recently used")
def _():
    c, _ = make(2)
    c.put("a", 1)
    c.put("b", 2)
    c.get("a")
    c.put("c", 3)
    eq("b" in c, False, "'b' in cache")
    eq(c.keys(), ["a", "c"], "keys()")


@case("peek and `in` do not change recency")
def _():
    c, _ = make(2)
    c.put("a", 1)
    c.put("b", 2)
    eq(c.peek("a"), 1)
    eq("a" in c, True)
    c.put("c", 3)
    eq(c.keys(), ["b", "c"], "keys()")


@case("updating an existing key refreshes recency and never evicts")
def _():
    c, _ = make(2)
    c.put("a", 1)
    c.put("b", 2)
    c.put("a", 10)
    eq(len(c), 2, "len")
    eq(c.keys(), ["b", "a"], "keys()")
    c.put("c", 3)
    eq(c.keys(), ["a", "c"], "keys()")
    eq(c.get("a"), 10)


@case("None is a storable value")
def _():
    c, _ = make(2)
    c.put("n", None)
    eq("n" in c, True, "'n' in cache")
    eq(c.get("n", "dflt"), None, "get")
    eq(c.peek("n", "dflt"), None, "peek")
    eq(len(c), 1, "len")


@case("delete")
def _():
    c, _ = make(3)
    c.put("a", 1)
    eq(c.delete("a"), True)
    eq(c.delete("a"), False)
    eq(len(c), 0)
    eq("a" in c, False)


@case("capacity validation")
def _():
    for bad in (0, -1, 2.5, "3"):
        raises(ValueError, lambda bad=bad: LRUCache(bad, clock=Clock()), f"capacity={bad!r}")
    c, _ = make(1)
    raises(ValueError, lambda: c.resize(0), "resize(0)")


@case("capacity 1")
def _():
    c, _ = make(1)
    c.put("a", 1)
    c.put("b", 2)
    eq(c.keys(), ["b"])
    eq(c.get("a"), None)


@case("ttl expiry boundary is exclusive")
def _():
    c, clk = make(3)
    c.put("a", 1, ttl=10)
    clk.t += 9.999
    eq(c.get("a"), 1, "just before expiry")
    clk.t = 1010.0
    eq(c.get("a"), None, "exactly at expiry")
    eq("a" in c, False, "in after expiry")


@case("get does not extend lifetime; put restarts it")
def _():
    c, clk = make(3)
    c.put("a", 1, ttl=5)
    clk.t += 4
    eq(c.get("a"), 1)
    clk.t += 1
    eq(c.get("a"), None, "after 5s despite get at 4s")
    c.put("b", 1, ttl=5)
    clk.t += 4
    c.put("b", 2, ttl=5)
    clk.t += 4
    eq(c.get("b"), 2, "re-put restarts lifetime")


@case("default_ttl and explicit ttl override")
def _():
    c, clk = make(3, default_ttl=5)
    c.put("a", 1)
    c.put("b", 2, ttl=20)
    clk.t += 6
    eq(c.keys(), ["b"], "keys()")
    eq(c.get("a", "gone"), "gone")


@case("len/keys/in ignore expired entries without a prior get")
def _():
    c, clk = make(5)
    c.put("a", 1, ttl=1)
    c.put("b", 2)
    c.put("c", 3, ttl=1)
    clk.t += 2
    eq(len(c), 1, "len")
    eq(c.keys(), ["b"], "keys()")
    eq("c" in c, False, "'c' in cache")
    eq(c.delete("a"), False, "delete of expired key")


@case("expired entries never cause a live eviction")
def _():
    c, clk = make(2)
    c.put("a", 1, ttl=1)
    c.put("b", 2)
    clk.t += 5
    c.put("c", 3)
    eq(c.keys(), ["b", "c"], "keys()")
    c2, clk2 = make(2)
    c2.put("x", 1)
    c2.put("y", 2, ttl=1)
    clk2.t += 5
    c2.put("z", 3)
    eq(c2.keys(), ["x", "z"], "keys() when the expired entry is not the LRU one")


@case("peek on expired entry")
def _():
    c, clk = make(2)
    c.put("a", 1, ttl=1)
    clk.t += 1
    eq(c.peek("a", "dflt"), "dflt")


@case("invalid ttl rejected")
def _():
    c, _ = make(2)
    raises(ValueError, lambda: c.put("a", 1, ttl=0), "ttl=0")
    raises(ValueError, lambda: c.put("a", 1, ttl=-3), "ttl=-3")

    def bad_default():
        cc = LRUCache(2, default_ttl=0, clock=Clock())
        cc.put("a", 1)
    raises(ValueError, bad_default, "default_ttl=0")


@case("resize shrinks by evicting LRU, grow keeps entries")
def _():
    c, _ = make(4)
    for k in "abcd":
        c.put(k, k)
    c.get("a")
    c.resize(2)
    eq(c.capacity, 2)
    eq(c.keys(), ["d", "a"], "keys() after shrink")
    c.resize(3)
    c.put("e", 1)
    eq(c.keys(), ["d", "a", "e"], "keys() after grow")


@case("resize does not evict live entries for expired ones")
def _():
    c, clk = make(3)
    c.put("a", 1)
    c.put("b", 2, ttl=1)
    c.put("c", 3)
    clk.t += 2
    c.resize(2)
    eq(c.keys(), ["a", "c"], "keys()")


@case("uses the injected clock only")
def _():
    real, real_time = time.monotonic, time.time
    calls = []

    def boom():
        calls.append(1)
        return real()
    time.monotonic = boom
    time.time = boom
    try:
        c, clk = make(2, clock=Clock(5.0))
        c.put("a", 1, ttl=3)
        clk.t = 8.0
        eq(c.get("a"), None)
    finally:
        time.monotonic, time.time = real, real_time
    if calls:
        raise AssertionError("cache read the real clock")


@case("many operations stay consistent")
def _():
    c, clk = make(50)
    for i in range(1000):
        c.put(i, i * 2, ttl=100 if i % 3 == 0 else None)
        if i % 7 == 0:
            c.get(i - 20)
        clk.t += 0.25
    ks = c.keys()
    eq(len(ks), 50, "len(keys())")
    eq(len(c), 50, "len")
    eq(ks[-1], 999, "most recent")
    for k in ks:
        eq(c.peek(k), k * 2, f"value for {k}")


print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
