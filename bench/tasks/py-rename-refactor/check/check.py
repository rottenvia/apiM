"""Hidden grader for py-rename-refactor."""
import ast
import json
import os
import subprocess
import sys
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.getcwd()
sys.path.insert(0, WS)

cases = 0
passed = 0


def check(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}: {detail}")


def run(args, cwd, **kw):
    return subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True, timeout=30, **kw)


def finish():
    print(f"SCORE {passed}/{cases}")
    sys.exit(0 if passed == cases else 1)


# 1. behaviour of every path through the package is unchanged, and none of the
#    package's own code goes through the deprecated name (DeprecationWarning is an error).
orig = run([os.path.join(HERE, "probe.py"), "orig"], os.path.join(HERE, "orig"))
new = run([os.path.join(HERE, "probe.py"), "new"], WS)
want = json.loads(orig.stdout)
try:
    got = json.loads(new.stdout)
except ValueError:
    got = None
if got is None:
    check("package imports and calculate_total exists", False, (new.stderr or new.stdout).strip().splitlines()[-1:])
    finish()
for key in sorted(want):
    check(f"behaviour[{key}]", got.get(key) == want[key], f"got {got.get(key)!r}, want {want[key]!r}")

# 2. public names
import shop  # noqa: E402
import shop.pricing  # noqa: E402

check("shop.calculate_total exported", getattr(shop, "calculate_total", None) is shop.pricing.calculate_total,
      "shop.calculate_total should be the same object as shop.pricing.calculate_total")
check("calculate_total in shop.__all__", "calculate_total" in getattr(shop, "__all__", []), "missing from __all__")
check("calculate_total keeps a docstring", bool((shop.pricing.calculate_total.__doc__ or "").strip()), "no docstring")

# 3. the old name still works for callers, with a DeprecationWarning
for where in ("shop.calc", "shop.pricing.calc"):
    obj = shop if where == "shop.calc" else shop.pricing
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        fn = getattr(obj, "calc", None)
        if not callable(fn):
            check(f"{where} still callable", False, "missing")
            continue
        try:
            res = fn([("9.99", 2), ("5", 1)], "reduced")
            res2 = fn([(100, 1)], region="default", discount=None)
        except Exception as e:  # noqa: BLE001
            res = res2 = f"raised {e!r}"
    check(f"{where} returns the same results", repr(res) == "Decimal('26.23')" and repr(res2) == "Decimal('120.00')",
          f"got {res!r}, {res2!r}")
    check(f"{where} warns DeprecationWarning", any(issubclass(x.category, DeprecationWarning) for x in w),
          "calling the old name did not emit a DeprecationWarning")
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    shop.pricing.calculate_total([("1", 1)])
check("calculate_total itself does not warn", not any(issubclass(x.category, DeprecationWarning) for x in w),
      "calculate_total emitted a DeprecationWarning")

# 4. the CLI keeps its `calc` subcommand
for args, want_out in ((["calc", "9.99:2", "5:1", "--region", "reduced"], "26.23"), (["tax", "100"], "20.00")):
    r = run(["-W", "error::DeprecationWarning", "-m", "shop", *args], WS)
    check(f"python -m shop {' '.join(args)}", r.returncode == 0 and r.stdout.strip() == want_out,
          f"exit {r.returncode}, stdout {r.stdout.strip()!r}, stderr {r.stderr.strip()[-200:]!r}")

# 5. the project's own tests still pass
r = run(["-m", "unittest", "discover", "-s", "tests", "-t", "."], WS)
check("tests/ pass", r.returncode == 0 and "Ran 0 tests" not in r.stderr, r.stderr.strip()[-300:])


# 6. no remaining references to the old function name in code
class Finder(ast.NodeVisitor):
    WARNISH = ("warn", "Warn", "deprecat", "Deprecat")

    def __init__(self, rel):
        self.rel = rel
        self.scopes = [set()]
        self.parents = []
        self.problems = []
        self.is_init = rel.replace(os.sep, "/") == "shop/__init__.py"
        self.is_pricing = rel.replace(os.sep, "/") == "shop/pricing.py"
        self.in_package = rel.replace(os.sep, "/").startswith("shop/")

    def generic_visit(self, node):
        self.parents.append(node)
        super().generic_visit(node)
        self.parents.pop()

    def _locals(self, fn):
        names = {a.arg for a in ast.walk(fn.args) if isinstance(a, ast.arg)} if hasattr(fn, "args") else set()
        body = fn.body if isinstance(fn.body, list) else [fn.body]
        for stmt in body:
            for n in ast.walk(stmt):
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                    names.add(n.id)
        return names

    def visit_FunctionDef(self, node):
        self.scopes.append(self._locals(node))
        self.generic_visit(node)
        self.scopes.pop()

    visit_AsyncFunctionDef = visit_FunctionDef
    visit_Lambda = visit_FunctionDef

    def _in_warning_context(self):
        for p in self.parents:
            src = None
            if isinstance(p, ast.With):
                src = " ".join(ast.dump(i.context_expr) for i in p.items)
            elif isinstance(p, ast.Call):
                src = ast.dump(p.func)
            if src and any(w in src for w in self.WARNISH):
                return True
        return False

    def visit_Name(self, node):
        if node.id == "calc" and isinstance(node.ctx, ast.Load) and not self.is_init:
            local = len(self.scopes) > 1 and "calc" in self.scopes[-1]
            if not local and not self._in_warning_context():
                self.problems.append(f"{self.rel}:{node.lineno} still uses `calc`")

    def visit_Attribute(self, node):
        if node.attr == "calc" and isinstance(node.value, ast.Name) and node.value.id in ("pricing", "shop") \
                and not self.is_init and not self._in_warning_context():
            self.problems.append(f"{self.rel}:{node.lineno} still uses `{node.value.id}.calc`")
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        if self.in_package and not self.is_init and not self.is_pricing:
            for a in node.names:
                if a.name == "calc":
                    self.problems.append(f"{self.rel}:{node.lineno} still imports `calc`")
        self.generic_visit(node)


problems = []
for root, dirs, files in os.walk(WS):
    dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
    for name in files:
        if name.endswith(".py"):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, WS)
            try:
                tree = ast.parse(open(path, encoding="utf8").read(), path)
            except SyntaxError as e:
                problems.append(f"{rel}: syntax error {e}")
                continue
            f = Finder(rel)
            f.visit(tree)
            problems += f.problems
check("no stale references to the old name", not problems, "; ".join(problems[:6]))

finish()
