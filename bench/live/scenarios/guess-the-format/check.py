import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

CASES = [('server.port = 8080\nserver.host = example.org\n', 'server:\n  host: example.org\n  port: 8080\n'), ('# who runs it\nowner = ops\n\n   # indented comment\nteam   =   platform  \n', 'owner: ops\nteam: platform\n'), ('zeta = 1\nalpha.b = 2\nalpha.a = 3\nmid = 4\n', 'alpha:\n  a: 3\n  b: 2\nmid: 4\nzeta: 1\n'), ('debug = Yes\ncache.enabled = OFF\nverbose = true\nname = yesterday\n', 'cache:\n  enabled: false\ndebug: true\nname: yesterday\nverbose: true\n'), ('title = "  Hello,  World  "\nmotto = "on"\npath = C:\\data\n', 'motto: on\npath: C:\\data\ntitle:   Hello,  World  \n'), ('hosts[] = a.example\nhosts[] = b.example\nhosts[] = a.example\nretries = 3\n', 'hosts:\n  - a.example\n  - b.example\n  - a.example\nretries: 3\n'), ('level = info\nlevel = warn\nurl = http://x.example/?a=b&c=d\n', 'level: warn\nurl: http://x.example/?a=b&c=d\n'), ('db = main\ndb.user = app\ndb.pool.size = 5\nnote =\n', 'db:\n  _: main\n  pool:\n    size: 5\n  user: app\nnote: ~\n'), ('a.b.c.d = deep\na.b.x = 1\n', 'a:\n  b:\n    c:\n      d: deep\n    x: 1\n'), ('# only comments\n\nk = v\n', 'k: v\n'), ('list.items[] = No\nlist.items[] = "no"\nlist.items[] = maybe\n', 'list:\n  items:\n    - false\n    - no\n    - maybe\n'), ('x = 1\nx.y = 2\nx.z.w = 3\n', 'x:\n  _: 1\n  y: 2\n  z:\n    w: 3\n'), ('flag = TRUE\nflag = false\n', 'flag: false\n'), ('q = "a = b"\nw =    spaced out value   \n', 'q: a = b\nw: spaced out value\n'), ('b.b = 1\nb.a = 2\na.b = 3\na.a = 4\nc = 5\n', 'a:\n  a: 4\n  b: 3\nb:\n  a: 2\n  b: 1\nc: 5\n'), ('empty =\nnested.empty =\nnested.full = 1\n', 'empty: ~\nnested:\n  empty: ~\n  full: 1\n'), ('p[] = 1\nq.r[] = on\nq.r[] = 2\nq.s = "x  y"\n', 'p:\n  - 1\nq:\n  r:\n    - true\n    - 2\n  s: x  y\n'), ('eq = a=b=c\nurl = https://h.example/p?x=1\n', 'eq: a=b=c\nurl: https://h.example/p?x=1\n'), ('  spaced.key   = value\n\tspaced.other\t=\tOn\n', 'spaced:\n  key: value\n  other: true\n'), ('m.n = 1\nm = top\nm.o = 2\n', 'm:\n  _: top\n  n: 1\n  o: 2\n')]
def tidy(text):
    return [line.rstrip() for line in text.replace("\r\n", "\n").rstrip("\n").split("\n")]
for n, (given, want) in enumerate(CASES, 1):
    code, out, err = c.python("convert.py", stdin=given, timeout=20)
    kind = f"example {n:02d}" if n <= 8 else f"unseen {n - 8:02d}"
    c.row(kind, code == 0 and tidy(out) == tidy(want), f"for {given!r} got {(out or err)[-160:]!r}, want {want!r}")

c.done()
