import json
import os
import subprocess
import sys
import tempfile

ROOT = os.getcwd()
TMP = tempfile.mkdtemp(prefix="mdstat-check-")

DOC_A = """# Title

Some words here, and a [link](http://a.example) plus [another](b.md).

```python
# not a heading
x = [1](2)
```

## Section two

Final line with don't and well-known words.
"""
DOC_B = "Just one line without newline"
DOC_C = """~~~
code only
~~~
### Deep heading ###
![img](i.png) [ok](ok.md)
"""

files = {"a.md": DOC_A, "b.md": DOC_B, "sub dir/c.md": DOC_C}
for name, text in files.items():
    p = os.path.join(TMP, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)
with open(os.path.join(TMP, "latin1.md"), "wb") as fh:
    fh.write(b"caf\xe9 \xff\xfe broken\n")

EXPECT = {
    "a.md": dict(lines=12, words=18, headings=2, code_blocks=1, links=2),
    "b.md": dict(lines=1, words=5, headings=0, code_blocks=0, links=0),
    "sub dir/c.md": dict(lines=5, words=6, headings=1, code_blocks=1, links=1),
}
KEYS = ["lines", "words", "headings", "code_blocks", "links"]


def run(args, stdin=""):
    env = dict(os.environ, PYTHONPATH=ROOT, PYTHONIOENCODING="utf-8")
    r = subprocess.run([sys.executable, "-m", "mdstat", *args], cwd=TMP, input=stdin,
                       capture_output=True, text=True, timeout=20, env=env)
    return r.returncode, r.stdout, r.stderr


def block(name, st):
    return "\n".join([f"== {name} =="] + [f"{k}: {st[k]}" for k in KEYS])


cases = passed = 0


def expect(label, ok, detail=""):
    global cases, passed
    cases += 1
    if ok:
        passed += 1
    else:
        print(f"FAIL {label}" + (f": {detail}" if detail else ""))


def norm(s):
    return "\n".join(line.rstrip() for line in s.strip("\n").splitlines())


try:
    code, out, err = run(["a.md"])
    expect("single file text output", code == 0 and norm(out) == block("a.md", EXPECT["a.md"]),
           f"exit {code}, stdout {out!r}, stderr {err[-300:]!r}")

    code, out, err = run(["b.md", "sub dir/c.md"])
    want = block("b.md", EXPECT["b.md"]) + "\n\n" + block("sub dir/c.md", EXPECT["sub dir/c.md"])
    expect("two files, blank-line separated", code == 0 and norm(out) == want, f"exit {code}, stdout {out!r}")

    code, out, err = run(["-"], stdin=DOC_A)
    expect("stdin via -", code == 0 and norm(out) == block("<stdin>", EXPECT["a.md"]), f"exit {code}, stdout {out!r}")

    code, out, err = run(["b.md", "-"], stdin=DOC_C)
    want = block("b.md", EXPECT["b.md"]) + "\n\n" + block("<stdin>", EXPECT["sub dir/c.md"])
    expect("file then stdin", code == 0 and norm(out) == want, f"exit {code}, stdout {out!r}")

    code, out, err = run(["missing.md"])
    expect("missing file exits 1", code == 1, f"exit {code}")
    expect("missing file message on stderr", "mdstat: cannot read missing.md" in err and "==" not in out,
           f"stdout {out!r}, stderr {err!r}")

    code, out, err = run(["a.md", "nope.md", "b.md"])
    want = block("a.md", EXPECT["a.md"]) + "\n\n" + block("b.md", EXPECT["b.md"])
    expect("keeps going after a missing file", code == 1 and norm(out) == want and "cannot read nope.md" in err,
           f"exit {code}, stdout {out!r}, stderr {err!r}")

    code, out, err = run(["sub dir"])
    expect("directory is a read error", code == 1 and "cannot read sub dir" in err and "Traceback" not in err,
           f"exit {code}, stderr {err[-300:]!r}")

    code, out, err = run(["latin1.md", "b.md"])
    expect("non-UTF-8 file is a read error", code == 1 and "cannot read latin1.md" in err
           and norm(out) == block("b.md", EXPECT["b.md"]) and "Traceback" not in err,
           f"exit {code}, stdout {out!r}, stderr {err[-300:]!r}")

    code, out, err = run([])
    expect("no arguments is a usage error (exit 2)", code == 2 and err.strip() != "" and "Traceback" not in err,
           f"exit {code}, stderr {err[-300:]!r}")

    code, out, err = run(["--frobnicate", "a.md"])
    expect("unknown option exits 2", code == 2 and "Traceback" not in err, f"exit {code}, stderr {err[-300:]!r}")

    code, out, err = run(["--help"])
    expect("--help exits 0 with usage on stdout", code == 0 and "usage" in out.lower(), f"exit {code}, stdout {out[:200]!r}")

    code, out, err = run(["--json", "a.md", "-", "gone.md"], stdin=DOC_B)
    try:
        data = json.loads(out)
    except ValueError:
        data = None
    want = [dict(file="a.md", **EXPECT["a.md"]), dict(file="<stdin>", **EXPECT["b.md"])]
    expect("--json output", data == want, f"stdout {out[:400]!r}")
    expect("--json with a missing file exits 1", code == 1 and "cannot read gone.md" in err, f"exit {code}")

    code, out, err = run(["b.md", "--json"])
    try:
        data = json.loads(out)
    except ValueError:
        data = None
    expect("--json after the file", code == 0 and data == [dict(file="b.md", **EXPECT["b.md"])], f"stdout {out[:300]!r}")
except subprocess.TimeoutExpired:
    expect("command finished in time", False, "timed out (waiting on stdin?)")

print(f"SCORE {passed}/{cases}")
sys.exit(0 if passed == cases else 1)
