import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import shutil
from checklib import manifest
start, now = manifest(FILES), manifest(c.ws)
for folder in ("vendor/", "tests/"):
    moved = sorted(p for p in set(start) | set(now) if p.startswith(folder) and start.get(p) != now.get(p))
    c.row(f"{folder} was left alone", not moved, moved)
    shutil.rmtree(c.ws / folder, ignore_errors=True)
    shutil.copytree(FILES / folder, c.ws / folder)
c.passes("the tests pass with the vendor copy and the tests as they were", "-m", "unittest", "-q")
setup = '''
import os, tempfile
from app.importer import load_contacts
def got(data):
    handle, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(handle, "wb") as f:
        f.write(data)
    try:
        return load_contacts(path)
    finally:
        os.remove(path)
WANT = [{"name": "Ann", "email": "ann@example.org"}, {"name": "Bo", "email": "bo@example.org"}]
'''
c.cases("windows files", setup, [
    ("got(b'\\xef\\xbb\\xbfname,email\\r\\nAnn,ann@example.org\\r\\nBo,bo@example.org\\r\\n') == WANT", True),
    ("got(b'name,email\\r\\nAnn,ann@example.org\\r\\nBo,bo@example.org') == WANT", True),
    ("got(b'name,email\\nAnn,ann@example.org\\nBo,bo@example.org\\n') == WANT", True),
])

c.done()
