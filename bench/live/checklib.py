"""What every hidden check is built from: rows that pass or fail, programs run with a time limit, and cases
evaluated in the chat's folder by a process of their own (a loop that never ends fails a row, not the check)."""
import hashlib, json, os, subprocess, sys
from pathlib import Path

LEFTOVERS = {".outputs", ".snapshots", ".history", ".analysis", ".packages", "__pycache__", ".pytest_cache", ".git", "node_modules"}


def manifest(folder):
    out = {}
    for p in sorted(Path(folder).rglob("*")):
        if p.is_file() and not LEFTOVERS & set(p.relative_to(folder).parts):
            out[p.relative_to(folder).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def plain(data):
    """A file's text with line ends and trailing blanks out of the comparison."""
    return [line.rstrip() for line in data.decode("utf-8", "replace").replace("\r\n", "\n").rstrip().split("\n")]


class Check:
    def __init__(self):
        self.ws, self.turn, self.rows = Path(sys.argv[1]).resolve(), int(sys.argv[2]), []
        before = os.environ.get("LIVE_BEFORE", "")
        self.before = json.loads(Path(before).read_text("utf-8")) if before and Path(before).exists() else {}
        # What the reply said and the tool calls it made; None when the check runs on the reference solution.
        reply = os.environ.get("LIVE_REPLY", "")
        self.reply = json.loads(Path(reply).read_text("utf-8")) if reply and Path(reply).is_file() else None

    def told(self, name, ok):
        """A row about the reply itself (`ok` takes its text and its tool calls); passes where there is no reply to read."""
        self.row(name, self.reply is None or ok(self.reply["text"], self.reply["tools"]))

    def row(self, name, ok, detail=""):
        self.rows.append((name, bool(ok), "" if ok else " ".join(str(detail).split())[:300]))

    def test(self, name, fn):
        """`fn` passes by returning None or True; anything else it returns, or raises, is why it failed."""
        try:
            r = fn()
            self.row(name, r is None or r is True, r)
        except Exception as e:
            self.row(name, False, f"{type(e).__name__}: {e}")

    def run(self, *cmd, timeout=60, stdin=None):
        try:
            r = subprocess.run(list(cmd), cwd=self.ws, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, input=stdin, env=dict(os.environ, PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1"))
            return r.returncode, r.stdout, r.stderr
        except subprocess.TimeoutExpired:
            return 124, "", "ran out of time"

    def python(self, *args, **kw):
        return self.run(sys.executable, *args, **kw)

    def passes(self, name, *args, timeout=120):
        code, out, err = self.python(*args, timeout=timeout)
        self.row(name, code == 0, (err or out)[-300:])

    def cases(self, group, setup, cases, timeout=30):
        """(expression, expected value) pairs, each evaluated after `setup`. `raises(fn, Kind)` is there for
        errors: it gives True when `fn()` raises a `Kind`."""
        helper = "def raises(fn, kind=Exception):\n    try: fn()\n    except kind: return True\n    except BaseException as e: return 'raised ' + type(e).__name__\n    return 'raised nothing'\n"
        code = (
            "import json, sys\nsys.path.insert(0, '.')\n" + helper + "out, boot = [], None\n"
            "try:\n    exec(%r, globals())\nexcept BaseException as e:\n    boot = type(e).__name__ + ': ' + str(e)\n"
            "for x in %r:\n    if boot:\n        out.append(['error', boot]); continue\n"
            "    try: out.append(['ok', eval(x, globals())])\n    except BaseException as e: out.append(['error', type(e).__name__ + ': ' + str(e)])\n"
            "print('\\n@@' + json.dumps(out, default=repr))"
        ) % (setup, [x for x, _ in cases])
        _, out, err = self.python("-c", code, timeout=timeout)
        got = json.loads(out.rsplit("\n@@", 1)[1]) if "\n@@" in out else None
        for i, (expr, want) in enumerate(cases):
            if got is None:
                self.row(f"{group}: {expr}", False, (err or out or "no result")[-200:])
                continue
            kind, value = got[i]
            want = json.loads(json.dumps(want, default=repr))
            self.row(f"{group}: {expr}", kind == "ok" and value == want, f"got {value!r}, want {want!r}")

    def changed(self):
        """Files that are not as they were before this turn's message."""
        now = manifest(self.ws)
        return sorted(p for p in set(now) | set(self.before) if now.get(p) != self.before.get(p))

    def as_at_start(self, start, *rels):
        """One row per file: its text is what the scenario started with."""
        for rel in rels:
            mine, theirs = self.ws / rel, Path(start) / rel
            self.row(f"{rel} is as it was at the start", mine.is_file() and plain(mine.read_bytes()) == plain(theirs.read_bytes()), "missing" if not mine.is_file() else "it differs")

    def done(self):
        for name, ok, detail in self.rows:
            print(("ok   " if ok else "FAIL ") + name + ("" if ok else ": " + detail))
        good = sum(ok for _, ok, _ in self.rows)
        print(f"SCORE {good}/{len(self.rows)}")
        sys.exit(0 if good == len(self.rows) else 1)
