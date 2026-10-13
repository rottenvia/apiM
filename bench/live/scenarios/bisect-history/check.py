import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from checklib import Check, plain
c = Check()
FILES = Path(__file__).parent / "files"

import subprocess, tempfile
c.passes("the tests pass", "-m", "unittest", "-q")
c.cases("slugify", "from slugger.core import slugify", [
    ("slugify('Route 66')", "route-66"), ("slugify('7 Up & 3 Down')", "7-up-3-down"), ("slugify('Hello,  World!')", "hello-world"),
    ("slugify('the quick brown fox', max_length=10)", "the-quick"), ("slugify('Crème 7 Brûlée')", "creme-7-brulee"),
    ("slugify('The Art of War 2', drop_stopwords=True)", "art-war-2"), ("slugify('  --Spaces--  ')", "spaces"),
])
with tempfile.TemporaryDirectory() as tmp:
    subprocess.run([sys.executable, str(Path(__file__).parent / "setup.py")], cwd=tmp, check=True, capture_output=True)
    bad = subprocess.run(["git", "log", "--format=%H", "--grep", 'Tidy the separator handling'], cwd=tmp, capture_output=True, text=True).stdout.strip()
c.told("the reply names the commit", lambda text, tools: bad[:7] in text or 'Tidy the separator handling'.lower() in text.lower())

c.done()
