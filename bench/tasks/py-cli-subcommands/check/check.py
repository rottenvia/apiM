"""Hidden grader for py-cli-subcommands: drive todo.py through subprocess."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

WS = os.getcwd()
TODO = os.path.join(WS, "todo.py")

cases = 0
passed = 0


class Env:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="todo-check-")
        self.db = os.path.join(self.dir, "tasks.json")

    def run(self, *args, db=True, cwd=None):
        argv = [sys.executable, TODO] + (["--db", self.db] if db else []) + list(args)
        r = subprocess.run(argv, cwd=cwd or self.dir, capture_output=True, text=True, timeout=15,
                           env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        return r.returncode, r.stdout.splitlines(), r.stderr

    def ok(self, *args, **kw):
        code, out, err = self.run(*args, **kw)
        if code != 0:
            raise AssertionError(f"`todo.py {' '.join(args)}` exited {code}: {err.strip()[-200:]}")
        return [l.rstrip() for l in out]

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def case(label):
    def deco(fn):
        global cases, passed
        cases += 1
        env = Env()
        try:
            fn(env)
            passed += 1
        except AssertionError as e:
            print(f"FAIL {label}: {e}")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {label}: {''.join(traceback.format_exception_only(type(e), e)).strip()}")
        finally:
            env.close()
    return deco


def eq(got, want, what=""):
    if got != want:
        raise AssertionError(f"{what} got {got!r}, want {want!r}")


def user_error(env, *args):
    code, out, err = env.run(*args)
    eq(code, 1, f"exit code of `{' '.join(args)}`")
    if not err.strip().startswith("error:"):
        raise AssertionError(f"`{' '.join(args)}` stderr should start with 'error:', got {err.strip()[:120]!r}")
    eq([l for l in out if l.strip()], [], f"stdout of `{' '.join(args)}`")
    return err


@case("add prints the new id and list shows tasks")
def _(env):
    eq(env.ok("add", "buy", "milk"), ["Added #1: buy milk"])
    eq(env.ok("add", "call mom"), ["Added #2: call mom"])
    eq(env.ok("list"), ["#1 [ ] buy milk", "#2 [ ] call mom"])


@case("empty list")
def _(env):
    eq(env.ok("list"), ["No tasks."])
    eq(env.ok("list", "--all"), ["No tasks."])


@case("tasks persist in a JSON file at --db")
def _(env):
    env.ok("add", "one")
    env.ok("add", "two")
    with open(env.db, encoding="utf-8") as f:
        json.load(f)
    eq(env.ok("list"), ["#1 [ ] one", "#2 [ ] two"])


@case("default db is todo.json in the current directory")
def _(env):
    env.ok("add", "here", db=False)
    if not os.path.exists(os.path.join(env.dir, "todo.json")):
        raise AssertionError("todo.json was not created in the working directory")
    eq(env.ok("list", db=False), ["#1 [ ] here"])


@case("priority marker and filter")
def _(env):
    env.ok("add", "low", "thing", "--priority", "low")
    env.ok("add", "--priority", "high", "urgent", "thing")
    env.ok("add", "plain")
    eq(env.ok("list"), ["#1 [ ] low thing", "#2 [ ] urgent thing (!)", "#3 [ ] plain"])
    eq(env.ok("list", "--priority", "high"), ["#2 [ ] urgent thing (!)"])
    eq(env.ok("list", "--priority", "normal"), ["#3 [ ] plain"])


@case("done hides tasks from list; --all shows them")
def _(env):
    for t in ("a", "b", "c"):
        env.ok("add", t)
    eq(env.ok("done", "2"), ["Done #2"])
    eq(env.ok("list"), ["#1 [ ] a", "#3 [ ] c"])
    eq(env.ok("list", "--all"), ["#1 [ ] a", "#2 [x] b", "#3 [ ] c"])


@case("done with several ids, already-done message")
def _(env):
    for t in ("a", "b", "c"):
        env.ok("add", t)
    env.ok("done", "1")
    eq(env.ok("done", "3", "1"), ["Done #3", "#1 was already done"])
    eq(env.ok("list"), ["#2 [ ] b"])


@case("done with an unknown id changes nothing")
def _(env):
    env.ok("add", "a")
    env.ok("add", "b")
    err = user_error(env, "done", "1", "7")
    if "#7" not in err:
        raise AssertionError(f"error should name task #7, got {err.strip()!r}")
    eq(env.ok("list"), ["#1 [ ] a", "#2 [ ] b"], "after failed done:")


@case("remove, and ids are never reused")
def _(env):
    for t in ("a", "b", "c"):
        env.ok("add", t)
    eq(env.ok("remove", "3"), ["Removed #3: c"])
    eq(env.ok("remove", "1"), ["Removed #1: a"])
    eq(env.ok("add", "d"), ["Added #4: d"])
    eq(env.ok("list", "--all"), ["#2 [ ] b", "#4 [ ] d"])


@case("remove unknown id")
def _(env):
    env.ok("add", "a")
    user_error(env, "remove", "5")
    eq(env.ok("list"), ["#1 [ ] a"])


@case("blank text is rejected, surrounding whitespace trimmed")
def _(env):
    user_error(env, "add", "   ")
    eq(env.ok("add", "  padded  "), ["Added #1: padded"])
    eq(env.ok("list"), ["#1 [ ] padded"])


@case("usage errors exit 2")
def _(env):
    for args in ([], ["frobnicate"], ["done"], ["done", "abc"], ["remove", "x"], ["add"],
                 ["add", "x", "--priority", "urgent"]):
        code, out, err = env.run(*args)
        eq(code, 2, f"exit code of `todo.py {' '.join(args)}`")
    if os.path.exists(env.db):
        with open(env.db, encoding="utf-8") as f:
            data = f.read()
        if "urgent" in data:
            raise AssertionError("an invalid add was stored")


@case("corrupt db is reported and left untouched")
def _(env):
    with open(env.db, "w", encoding="utf-8") as f:
        f.write("{not json")
    user_error(env, "add", "x")
    user_error(env, "list")
    with open(env.db, encoding="utf-8") as f:
        eq(f.read(), "{not json", "db contents")


@case("unicode text round-trips")
def _(env):
    eq(env.ok("add", "café", "☕"), ["Added #1: café ☕"])
    eq(env.ok("list"), ["#1 [ ] café ☕"])


print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
