import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import hashlib
left = sorted(p.relative_to(c.ws).as_posix() for p in c.ws.rglob("*") if p.is_file() and ".outputs" not in p.parts and ".snapshots" not in p.parts)
for what, gone in (("build/", lambda p: p.startswith("build/")), ("dist/", lambda p: p.startswith("dist/")), ("every __pycache__", lambda p: "__pycache__/" in p), ("every .pyc", lambda p: p.endswith(".pyc"))):
    c.row(f"{what} is gone", not [p for p in left if gone(p)], [p for p in left if gone(p)][:4])
for rel in ['.env', '.gitignore', 'README.md', 'build.py', 'data/build/README.txt', 'data/build/plan-2026.csv', 'data/sales.csv', 'docs/dist-notes.md', 'local.db', 'src/__init__.py', 'src/app.py', 'src/util.py', 'tools/release.py']:
    mine, theirs = c.ws / rel, FILES / rel
    c.row(f"{rel} is untouched", mine.is_file() and mine.read_bytes() == theirs.read_bytes(), "gone" if not mine.exists() else "changed")

c.done()
